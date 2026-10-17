import { expect, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane draws its tabs with no cards (${surface})`, async ($, on) => {
    const r = await ($ as any).ui.render({
      surface, component: 'Pane', requestId: 'agent-board',
      props: { title: 'Agent board', isFocused: true, bodyColumns: 0, placement: 'dock', scroll: {}, view: {} },
    })
    expect(JSON.stringify(r)).toContain('New card')
  })
}
