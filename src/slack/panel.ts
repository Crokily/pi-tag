/**
 * Block Kit control panel for the bare `/pi` command.
 *
 * Pure block builders — no I/O — so the layout is unit-testable. The slash
 * command and the block-action handlers in commands.ts assemble PanelState,
 * render it here, and post it ephemerally via response_url.
 */

import type { ActionsBlock, ContextBlock, KnownBlock, PlainTextOption } from '@slack/types';
import { THINKING_LEVELS, type ThinkingLevel } from '../types.js';

export const PANEL_ACTIONS = {
  model: 'pi_panel_model',
  thinking: 'pi_panel_thinking',
  newSession: 'pi_panel_new',
  stop: 'pi_panel_stop',
  refresh: 'pi_panel_refresh',
} as const;

export interface PanelModelOption {
  ref: string;
  label: string;
}

export interface PanelState {
  channelName: string;
  model: string;
  thinking: string;
  workingDir: string;
  session: string;
  tokens: string;
  context: string;
  processing: boolean;
  models: PanelModelOption[];
  /** Effective model ref, used to preselect the model dropdown ('' = unknown) */
  currentModelRef: string;
  /** Explicit thinking override, used to preselect the dropdown ('' = none) */
  currentThinking: ThinkingLevel | '';
  /** One-line result of the action that triggered this re-render */
  notice?: string;
}

/** Slack caps static_select at 100 options and option labels at 75 chars. */
const MAX_SELECT_OPTIONS = 100;
const MAX_OPTION_TEXT = 75;

export function buildPanelBlocks(state: PanelState): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  if (state.notice) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: state.notice },
    });
  }

  const fields = [
    field('Model', state.model),
    field('Thinking', state.thinking),
    field('Session', state.session),
    field('Tokens', state.tokens),
    field('Context', state.context),
    field('Working dir', state.workingDir),
  ];
  if (state.processing) {
    fields.push(field('Activity', '🟡 processing a message'));
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*pi gateway — ${state.channelName}*` },
    fields,
  });

  const modelSelect = buildModelSelect(state);
  if (modelSelect) {
    blocks.push(modelSelect);
  }
  blocks.push(buildThinkingSelect(state));
  blocks.push(buildButtons());
  blocks.push(footer());

  return blocks;
}

function field(label: string, value: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text: `*${label}*\n${value}` };
}

function buildModelSelect(state: PanelState): ActionsBlock | null {
  if (state.models.length === 0) return null;

  const options: PlainTextOption[] = state.models.slice(0, MAX_SELECT_OPTIONS).map((model) => ({
    text: { type: 'plain_text', text: truncate(model.label, MAX_OPTION_TEXT) },
    value: model.ref,
  }));
  const initial = options.find((option) => option.value === state.currentModelRef);

  const overflow = state.models.length - options.length;
  return {
    type: 'actions',
    elements: [
      {
        type: 'static_select',
        action_id: PANEL_ACTIONS.model,
        placeholder: {
          type: 'plain_text',
          text: overflow > 0 ? `Switch model… (+${overflow} more via /pi model)` : 'Switch model…',
        },
        options,
        ...(initial ? { initial_option: initial } : {}),
      },
    ],
  };
}

function buildThinkingSelect(state: PanelState): ActionsBlock {
  const options: PlainTextOption[] = THINKING_LEVELS.map((level) => ({
    text: { type: 'plain_text', text: level },
    value: level,
  }));
  const initial = options.find((option) => option.value === state.currentThinking);

  return {
    type: 'actions',
    elements: [
      {
        type: 'static_select',
        action_id: PANEL_ACTIONS.thinking,
        placeholder: { type: 'plain_text', text: 'Thinking level…' },
        options,
        ...(initial ? { initial_option: initial } : {}),
      },
    ],
  };
}

function buildButtons(): ActionsBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: PANEL_ACTIONS.newSession,
        text: { type: 'plain_text', text: '🔄 New session' },
        confirm: {
          title: { type: 'plain_text', text: 'Start a new session?' },
          text: {
            type: 'mrkdwn',
            text: 'The current conversation is archived on disk and pi starts fresh.',
          },
          confirm: { type: 'plain_text', text: 'New session' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      },
      {
        type: 'button',
        action_id: PANEL_ACTIONS.stop,
        style: 'danger',
        text: { type: 'plain_text', text: '🛑 Stop task' },
        confirm: {
          title: { type: 'plain_text', text: 'Stop the current task?' },
          text: {
            type: 'mrkdwn',
            text: 'Aborts the running pi task and clears queued messages in this channel.',
          },
          confirm: { type: 'plain_text', text: 'Stop' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      },
      {
        type: 'button',
        action_id: PANEL_ACTIONS.refresh,
        text: { type: 'plain_text', text: '↻ Refresh' },
      },
    ],
  };
}

function footer(): ContextBlock {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Text commands still work: `/pi status · model <ref> · models · reset-model · thinking <level> · new · stop`',
      },
    ],
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
