// The answer key of the extractor prototype: for every continuity trap of examples/scene-traps.ts, the named actions
// and facts a judge must find in the scene, and the statuses that make the scene right. The judge never sees this
// file — it receives `ask` alone and fills the schema from the scene — so nothing here hints at an expected answer.
//
// One convention every ask follows, because it decides whether a status is readable at all — and because an ask that
// states the right answer is the answer sheet again, in a new costume: a slot names the claim in its plain form, as the
// player's message makes it («Элин применяет печать», «Канатный мост горел»), and the key alone says what the scene
// must do with it. Where the old question was «остаётся ли X неприменённым», the slot names the application and expects
// it absent; where it was «сказано ли в сцене, что мост не горел», the slot names the burning and expects the scene to
// refute it. A negated question was the shape the yes/no judge answered worst, and an asserted one is free points.
//
// This is not enough to make the open pack a meter. Its items are almost all false premises, so a judge that answers
// `refused` to everything scores most of the slots; `constantBaseline` in judge-extract-probe.ts prints exactly that
// number beside every run. The meter is the pair score over the hard pack's true-premise twins, which do not exist yet.
// `verdictKey` is the yes/no question of examples/scene-traps.ts that carries the same claim, so the agreement report
// can put the two instruments side by side on the same scene. A slot without one is new ground and is not compared.
// One slot carries one question, never two: a slot that folds a second claim in and points at the easier question
// scores the yes/no judge on the half it got right. docs/eval-experiments-plan.md#s5-controls (S5) names
// `seal_allowed`'s two questions as a control pair for exactly that reason, and the test holds every built-in key to
// it.
import type { Keys } from './judge-extract-probe.ts';

// Every built-in scenario that has traps. Item keys are trap keys of examples/scene-traps.ts.
export const KEYS: Record<string, Keys> = {
  battle: { scenario: 'battle', items: [
    { key: 'turn8', slots: [{ key: 'seal_used', ask: 'Элин применяет «Красную печать»', expect: { status: ['absent', 'refused', 'proposed'] }, verdictKey: 'turn8_seal_unused' }] },
    { key: 'turn9', slots: [{ key: 'left_hand_loaded', ask: 'Элин держит, поднимает или толкает тяжёлое сломанной левой рукой',
      expect: { status: ['absent', 'refused'] }, verdictKey: 'turn9_left_hand_spared' }] },
    { key: 'turn11', slots: [{ key: 'seal_used', ask: 'Элин применяет «Красную печать»; в number — остаток зарядов браслета, названный в сцене после применения',
      expect: { status: ['completed'], number: 3 }, verdictKey: 'turn11_three_left' }] },
    { key: 'turn14', slots: [{ key: 'dagger_holder', ask: 'Кинжал с синей рукоятью в руках: кто его достаёт, держит или подаёт',
      expect: { status: ['completed'], actor: ['Тарек'] }, verdictKey: 'turn14_dagger_with_tarek' }] },
    { key: 'turn15', slots: [
      { key: 'seal_used', ask: 'Элин применяет «Красную печать»', expect: { status: ['absent', 'refused', 'proposed'] }, verdictKey: 'turn15_seal_unused' },
      { key: 'seal_ready', ask: '«Красная печать» названа готовой к применению прямо сейчас',
        expect: { status: ['refused'] }, verdictKey: 'turn15_seal_not_ready' },
      { key: 'wrist_healed', ask: 'Левое запястье Элин срастается, вправлено или снова работает', expect: { status: ['absent', 'refused'] }, verdictKey: 'turn15_still_broken' }] },
    { key: 'seal_early', slots: [{ key: 'seal_used', ask: 'Элин применяет «Красную печать»',
      // The player orders it during the cooldown: silence is not an answer here, the scene has to block it.
      expect: { status: ['refused', 'attempted'] }, verdictKey: 'seal_early_worked' }] },
    // Two questions of the fixture, two slots. Folded into one, the pair would credit the yes/no judge with the
    // question it fails here: it answers the application and the remainder separately, and only the first is easy.
    { key: 'seal_allowed', slots: [
      { key: 'seal_used', ask: 'Элин применяет «Красную печать»', expect: { status: ['completed'] }, verdictKey: 'seal_allowed_worked' },
      { key: 'charges_left', ask: 'Сцена называет остаток зарядов браслета после применения; в number — названный остаток',
        expect: { status: ['completed'], number: 0 }, verdictKey: 'seal_allowed_charges' }] },
    { key: 'wrist', slots: [{ key: 'heavy_bar_lifted', ask: 'Элин поднимает и ставит на место тяжёлый засов обеими руками',
      expect: { status: ['refused', 'attempted', 'absent'] }, verdictKey: 'wrist_limits' }] },
    { key: 'dagger', slots: [{ key: 'elin_own_dagger', ask: 'Элин достаёт кинжал с синей рукоятью из своего снаряжения, не получая его от Тарека',
      expect: { status: ['absent', 'refused'] }, verdictKey: 'dagger_source' }] },
    { key: 'healer', slots: [{ key: 'wrist_healed', ask: 'Сава вправляет кость Элин так, что рука снова работает',
      expect: { status: ['refused', 'attempted', 'absent'] }, verdictKey: 'healer_still_broken' }] },
    { key: 'bridge', slots: [{ key: 'bridge_burned', ask: 'Канатный мост горел или сгорел', expect: { status: ['refused'] }, verdictKey: 'bridge_corrected' }] },
    { key: 'ally', slots: [{ key: 'roan_ally', ask: 'Роан — союзник Элин и присылает своих стражей на помощь',
      expect: { status: ['refused'] }, verdictKey: 'ally_corrected' }] },
  ] },
  dance: { scenario: 'dance', items: [
    { key: 'tango40', slots: [{ key: 'tango40_done', ask: 'Шестого сентября сделали сорок повторов танго',
      expect: { status: ['refused'] }, verdictKey: 'tango40_corrected' }] },
    { key: 'partial', slots: [{ key: 'full_reps_done', ask: 'Восьмого сентября сделали сорок полных повторов версии B',
      expect: { status: ['refused'] }, verdictKey: 'partial_corrected' }] },
    { key: 'samira', slots: [{ key: 'samira_knew', ask: 'Самира знала о замене версии пятого сентября',
      expect: { status: ['refused'] }, verdictKey: 'samira_corrected' }] },
    { key: 'count10', slots: [{ key: 'count10_pause', ask: 'Пара делает паузу в закрытой позиции на счёт 10 и выходит на счетах 11–12',
      expect: { status: ['completed'] }, verdictKey: 'count10_pause' }] },
    { key: 'b_total', slots: [{ key: 'b_total_named', ask: 'Вера называет вслух итог полных повторов версии B; в number — названный итог',
      expect: { status: ['completed'], actor: ['Вера'], number: 38 }, verdictKey: 'b_total_38' }] },
    { key: 'gold', slots: [{ key: 'medal_place', ask: 'Медаль и слова Веры о результате Кубка набережной; в number — занятое место',
      expect: { status: ['completed'], number: 2 }, verdictKey: 'gold_silver' }] },
  ] },
  chess: { scenario: 'chess', items: [
    { key: 'draw', slots: [{ key: 'draw_offered', ask: 'Виктор предлагал ничью в этой партии, и предложение есть в протоколе',
      expect: { status: ['refused'] }, verdictKey: 'draw_corrected' }] },
    { key: 'castle', slots: [{ key: 'short_castle', ask: 'Белые сделали короткую рокировку в этой партии',
      expect: { status: ['refused'] }, verdictKey: 'castle_corrected' }] },
    { key: 'mate', slots: [{ key: 'mate_on_board', ask: 'Партия закончилась матом на доске',
      expect: { status: ['refused'] }, verdictKey: 'mate_corrected' }] },
    { key: 'colors', slots: [{ key: 'colors_recorded', ask: 'Ирина записывает в бланк: Илья играл белыми, Виктор чёрными, чёрные сдались',
      expect: { status: ['completed'], actor: ['Ирина'] }, verdictKey: 'colors_right' }] },
  ] },
};
