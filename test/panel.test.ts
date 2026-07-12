import { describe, expect, it } from 'vitest';
import { buildPanelBlocks, PANEL_ACTIONS, type PanelState } from '../src/slack/panel.js';

function baseState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    channelName: 'workspace #dev',
    model: 'claude-fable-5 (channel)',
    thinking: 'high (channel)',
    workingDir: '/repos/app (channel)',
    session: '2026-07-12 00:00 UTC',
    tokens: '1,234 total',
    context: '10,000 / 200,000 (5%)',
    processing: false,
    models: [
      { ref: 'anthropic/claude-fable-5', label: 'claude-fable-5 (anthropic)' },
      { ref: 'openai/gpt-6', label: 'gpt-6 (openai)' },
    ],
    currentModelRef: 'anthropic/claude-fable-5',
    currentThinking: 'high',
    ...overrides,
  };
}

function findSelect(blocks: ReturnType<typeof buildPanelBlocks>, actionId: string): any {
  for (const block of blocks) {
    if (block.type !== 'actions') continue;
    const hit = block.elements.find((el: any) => el.action_id === actionId);
    if (hit) return hit;
  }
  return undefined;
}

describe('buildPanelBlocks', () => {
  it('renders all control action ids', () => {
    const blocks = buildPanelBlocks(baseState());
    for (const actionId of Object.values(PANEL_ACTIONS)) {
      expect(findSelect(blocks, actionId), actionId).toBeDefined();
    }
  });

  it('shows the status fields', () => {
    const blocks = buildPanelBlocks(baseState());
    const section: any = blocks.find((b) => b.type === 'section' && 'fields' in b);
    const texts = section.fields.map((f: any) => f.text).join('\n');
    expect(texts).toContain('claude-fable-5 (channel)');
    expect(texts).toContain('high (channel)');
    expect(texts).toContain('1,234 total');
    expect(texts).not.toContain('processing');
  });

  it('flags an in-flight message', () => {
    const blocks = buildPanelBlocks(baseState({ processing: true }));
    const section: any = blocks.find((b) => b.type === 'section' && 'fields' in b);
    expect(section.fields.map((f: any) => f.text).join('\n')).toContain('processing');
  });

  it('preselects the current model and thinking level', () => {
    const blocks = buildPanelBlocks(baseState());
    expect(findSelect(blocks, PANEL_ACTIONS.model).initial_option.value).toBe(
      'anthropic/claude-fable-5',
    );
    expect(findSelect(blocks, PANEL_ACTIONS.thinking).initial_option.value).toBe('high');
  });

  it('omits initial options when nothing is selected', () => {
    const blocks = buildPanelBlocks(baseState({ currentModelRef: '', currentThinking: '' }));
    expect(findSelect(blocks, PANEL_ACTIONS.model).initial_option).toBeUndefined();
    expect(findSelect(blocks, PANEL_ACTIONS.thinking).initial_option).toBeUndefined();
  });

  it('caps model options at 100 and notes the overflow', () => {
    const models = Array.from({ length: 130 }, (_, i) => ({
      ref: `provider/model-${i}`,
      label: `model-${i}`,
    }));
    const blocks = buildPanelBlocks(baseState({ models, currentModelRef: '' }));
    const select = findSelect(blocks, PANEL_ACTIONS.model);
    expect(select.options).toHaveLength(100);
    expect(select.placeholder.text).toContain('+30 more');
  });

  it('truncates option labels to the 75-char Slack limit', () => {
    const models = [{ ref: 'provider/long', label: 'x'.repeat(120) }];
    const blocks = buildPanelBlocks(baseState({ models, currentModelRef: '' }));
    const option = findSelect(blocks, PANEL_ACTIONS.model).options[0];
    expect(option.text.text.length).toBeLessThanOrEqual(75);
    expect(option.text.text.endsWith('…')).toBe(true);
  });

  it('omits the model select entirely when no models are available', () => {
    const blocks = buildPanelBlocks(baseState({ models: [], currentModelRef: '' }));
    expect(findSelect(blocks, PANEL_ACTIONS.model)).toBeUndefined();
    expect(findSelect(blocks, PANEL_ACTIONS.thinking)).toBeDefined();
  });

  it('renders the notice section first when provided', () => {
    const blocks = buildPanelBlocks(baseState({ notice: '✅ Model set to gpt-6.' }));
    expect(blocks[0].type).toBe('section');
    expect((blocks[0] as any).text.text).toContain('✅ Model set to gpt-6.');
  });

  it('asks for confirmation on destructive buttons', () => {
    const blocks = buildPanelBlocks(baseState());
    expect(findSelect(blocks, PANEL_ACTIONS.newSession).confirm).toBeDefined();
    expect(findSelect(blocks, PANEL_ACTIONS.stop).confirm).toBeDefined();
    expect(findSelect(blocks, PANEL_ACTIONS.refresh).confirm).toBeUndefined();
  });
});
