"""The captioner of the bot's pose sets (local/pose-set.ts, docs/telegram-ui.md#pose-set), on this computer's CPU.

    captioner/.venv/bin/python captioner/caption.py --model models/pose-captioner --threads 4

The bot starts it when a picture waits for a caption and ends it when none has for a minute. It reads one JSON line at
a time on its input, {"id": n, "path": "<a picture of the reader's own directory>"}, and answers each with one line on
its output: {"id": n, "pose": ..., "side": ..., "framing": ..., "confidence": ...}, or {"id": n, "error": "unreadable"}
for a picture it cannot read. Once the model is loaded it says {"ready": true}. It keeps nothing of a picture, opens no
connection, and answers nothing of one but those labels and a number; what its libraries say goes to its error output,
which the bot does not keep.

The model is openjev 0.8B (MIT; AlexWortega/openjev at revision a298f274886c4676c42f1a4262401b6aa9653e6d, the folder
qwen3.5-0.8b-nli-v2s-long), a Qwen3.5 cross-encoder for inference between a premise and a statement, which reads a
picture as its premise. Each label has one statement, and a label's score is the model's log-probability that the
picture entails it, renormalised over its axis. The picture is read once as it is and once mirrored, the mirror's left
and right swapped back, and the two scores added; each side and framing label then gets a constant, the front's and
the whole figure's none, since openjev puts most three-quarter views in front of the viewer while it still ranks them
apart. All of it is what was measured on 2026-09-28 against the pictures of the reference stands, the constants those
fitted on all five characters there, after the same fit on four at a time was checked on the fifth
(docs/knowledge/pose-captioner-2026-09-28.md). The statements and constants are pinned with it: changing one is a new
measurement.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

import torch  # noqa: E402
from PIL import Image  # noqa: E402

POSES = ['standing', 'sitting', 'walking', 'lying', 'kneeling', 'crouching']
SIDES = ['front', 'three-quarter left', 'three-quarter right', 'profile left', 'profile right', 'back']
FRAMINGS = ['full body', 'half body', 'head and shoulders']
MIRROR = {'front': 'front', 'back': 'back', 'three-quarter left': 'three-quarter right', 'three-quarter right': 'three-quarter left',
          'profile left': 'profile right', 'profile right': 'profile left'}
PREMISE = 'A picture: <<IMG>>'
STATEMENTS = {
    'pose': {
        'standing': 'The person is standing.', 'sitting': 'The person is sitting.', 'walking': 'The person is walking.',
        'lying': 'The person is lying down.', 'kneeling': 'The person is kneeling.', 'crouching': 'The person is crouching.',
    },
    'side': {
        'front': 'The person faces the viewer.',
        'three-quarter left': 'The person is turned three-quarters toward the left side of the picture.',
        'three-quarter right': 'The person is turned three-quarters toward the right side of the picture.',
        'profile left': 'The person is seen in profile, facing the left side of the picture.',
        'profile right': 'The person is seen in profile, facing the right side of the picture.',
        'back': 'The person has their back to the viewer.',
    },
    'framing': {
        'full body': 'The whole body of the person is visible, from head to feet.',
        'half body': 'Only the upper half of the person is visible, from the head to the waist or hips.',
        'head and shoulders': 'Only the head and shoulders of the person are visible.',
    },
}
PRIOR = {
    'pose': {},
    'side': {'three-quarter left': 1.25, 'three-quarter right': 1.25, 'profile left': 2.25, 'profile right': 2.25, 'back': 0.75},
    'framing': {'half body': 0.5, 'head and shoulders': 0.5},
}
# The picture as the model reads it: its shape kept, at about this many pixels, sides in multiples of 32.
MAX_PIXELS = 80 * 1024
# The bot keeps no picture over 4096 pixels a side (local/reference.ts); nothing larger is decoded here.
Image.MAX_IMAGE_PIXELS = 4096 * 4096


class Captioner:
    def __init__(self, path: str):
        from transformers import AutoImageProcessor, AutoModelForSequenceClassification, AutoTokenizer
        self.tok = AutoTokenizer.from_pretrained(path, local_files_only=True)
        self.model = AutoModelForSequenceClassification.from_pretrained(path, dtype=torch.float32, local_files_only=True).eval()
        self.model.config.get_text_config().pad_token_id = self.tok.pad_token_id
        self.images = AutoImageProcessor.from_pretrained(path, local_files_only=True)
        self.template = self.model.config.nli_template
        self.backbone = self.model.model
        self.image_id = self.tok.convert_tokens_to_ids('<|image_pad|>')
        self.statements = [(axis, label, text) for axis, table in STATEMENTS.items() for label, text in table.items()]

    @torch.no_grad()
    def scores(self, image: Image.Image) -> dict[str, dict[str, float]]:
        """Each label's log-probability of being entailed by the picture, renormalised over its axis. The premise is read
        once and its cache branched into one row a statement."""
        vision = self.images(images=[image], return_tensors='pt', size={'shortest_edge': 32 * 32, 'longest_edge': MAX_PIXELS})
        count = int(vision['image_grid_thw'].prod()) // self.images.merge_size ** 2
        premise = PREMISE.replace('<<IMG>>', '<|vision_start|>' + '<|image_pad|>' * count + '<|vision_end|>')
        sequences = [self.tok(self.template.format(premise=premise, hypothesis=text), add_special_tokens=False)['input_ids']
                     for _, _, text in self.statements]
        common = 0
        for column in zip(*sequences):
            if len(set(column)) != 1:
                break
            common += 1
        common = min(common, min(map(len, sequences)) - 1)
        prefix = torch.tensor([sequences[0][:common]])
        self.backbone.rope_deltas = None
        cache = self.backbone(input_ids=prefix, pixel_values=vision['pixel_values'], image_grid_thw=vision['image_grid_thw'],
                              mm_token_type_ids=(prefix == self.image_id).long(), use_cache=True).past_key_values
        cache.reorder_cache(torch.zeros(len(sequences), dtype=torch.long))
        suffixes = [one[common:] for one in sequences]
        lengths = torch.tensor([len(one) for one in suffixes])
        ids = torch.full((len(suffixes), int(lengths.max())), self.tok.pad_token_id, dtype=torch.long)
        for row, suffix in enumerate(suffixes):
            ids[row, :len(suffix)] = torch.tensor(suffix)
        # Right padding needs no mask: every row is read at its own last token, which nothing after it reaches.
        hidden = self.backbone(input_ids=ids, past_key_values=cache, use_cache=True,
                               cache_position=torch.arange(common, common + ids.shape[1])).last_hidden_state
        entailed = torch.softmax(self.model.score(hidden[torch.arange(len(suffixes)), lengths - 1]).float(), -1)[:, 1]
        out: dict[str, dict[str, float]] = {}
        for (axis, label, _), p in zip(self.statements, entailed):
            out.setdefault(axis, {})[label] = math.log(max(float(p), 1e-12))
        return {axis: normalised(values) for axis, values in out.items()}

    def caption(self, image: Image.Image) -> dict:
        plain = self.scores(image)
        mirror = self.scores(image.transpose(Image.Transpose.FLIP_LEFT_RIGHT))
        answer, confidence = {}, 1.0
        for axis, values in plain.items():
            other = {MIRROR[label]: value for label, value in mirror[axis].items()} if axis == 'side' else mirror[axis]
            total = normalised({label: value + other[label] + PRIOR[axis].get(label, 0.0) for label, value in values.items()})
            answer[axis] = max(total, key=total.get)
            confidence = min(confidence, math.exp(total[answer[axis]]))
        return {**answer, 'confidence': round(confidence, 3)}


def normalised(values: dict[str, float]) -> dict[str, float]:
    top = max(values.values())
    total = top + math.log(sum(math.exp(value - top) for value in values.values()))
    return {label: value - total for label, value in values.items()}


def read(path: str) -> Image.Image:
    with Image.open(path) as image:
        image.load()
        if image.mode in ('RGBA', 'LA', 'PA') or (image.mode == 'P' and 'transparency' in image.info):
            # A drawing on a transparent ground is read on white.
            rgba = image.convert('RGBA')
            ground = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
            return Image.alpha_composite(ground, rgba).convert('RGB')
        return image.convert('RGB')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    os.nice(10)
    torch.set_num_threads(max(1, args.threads))
    torch.set_num_interop_threads(1)
    # The answers go to the bot on a descriptor of their own. Whatever else writes to the output, a library's print or a
    # native one, goes where the bot does not read, never into the answers.
    answers = os.fdopen(os.dup(1), 'w', buffering=1, encoding='utf-8')
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    captioner = Captioner(args.model)
    print(json.dumps({'ready': True}), file=answers, flush=True)
    for line in sys.stdin:
        try:
            asked = json.loads(line)
            ask_id = asked['id']
        except (ValueError, KeyError, TypeError):
            continue
        try:
            answer = {'id': ask_id, **captioner.caption(read(str(asked['path'])))}
        except Exception:  # noqa: BLE001 - a picture it cannot read is answered as one, never with what went wrong
            answer = {'id': ask_id, 'error': 'unreadable'}
        print(json.dumps(answer), file=answers, flush=True)


if __name__ == '__main__':
    main()
