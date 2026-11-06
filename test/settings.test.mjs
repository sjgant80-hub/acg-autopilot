// test/settings.test.mjs — the hook settings a project copies (examples/claude-settings.json): the recorder on every
// event its hook reads, for every tool, and Claude Code's own file tools denied the record's folder, because the agent
// works beside its record until the job is bundled (the page's security section says what those rules do and do not
// cover). The file grants nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hookProblem } from '../bin/acg.mjs';

const S = JSON.parse(readFileSync(new URL('../examples/claude-settings.json', import.meta.url), 'utf8'));

test('the example settings call the recorder on each event its hook reads, every tool use included', () => {
  const events = Object.keys(S.hooks);
  assert.deepEqual(events.sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const ev of events) {
    assert.equal(hookProblem({ session_id: 's1', hook_event_name: ev, tool_name: 'Read', tool_input: {} }), null, ev + ' is an event the hook accepts');
    const groups = S.hooks[ev];
    assert.ok(Array.isArray(groups) && groups.length > 0, ev);
    assert.ok(groups.some((g) => g.hooks.some((h) => h.type === 'command' && /\bbin\/acg\.mjs hook$/.test(h.command))), ev + ' runs acg hook');
    if (ev.endsWith('ToolUse')) assert.ok(groups.some((g) => g.matcher === '*'), ev + ' matches every tool');
  }
});

test('they deny Claude Code’s own file tools reading or editing the record’s folder, and allow nothing', () => {
  const deny = S.permissions && S.permissions.deny;
  assert.ok(Array.isArray(deny));
  assert.ok(deny.includes('Read(./.acg/**)'), 'reading .acg');
  assert.ok(deny.includes('Edit(./.acg/**)'), 'editing .acg');
  assert.ok(!('allow' in S.permissions) && !('ask' in S.permissions), 'the example grants nothing');
  assert.deepEqual(Object.keys(S).sort(), ['hooks', 'permissions']);
});
