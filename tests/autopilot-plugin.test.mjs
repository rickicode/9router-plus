import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const pluginPath = process.env.AUTOPILOT_PLUGIN_PATH || new URL('../.opencode/plugins/autopilot.js', import.meta.url).pathname;
const { AutopilotPlugin } = await import(pathToFileURL(pluginPath));
const globalPluginPath = '/home/ricki/.config/opencode/plugins/autopilot.js';

async function runAutopilotCommand(argumentsText, ctx = { config: {} }) {
  const plugin = await AutopilotPlugin(ctx);
  const output = { parts: [{ type: 'text', text: 'existing command text' }] };

  await plugin['command.execute.before'](
    { command: 'autopilot', arguments: argumentsText },
    output,
  );

  return output.parts.map((part) => part.text).join('\n');
}

async function runAutopilotTool(args, ctx = { config: {} }) {
  const plugin = await AutopilotPlugin(ctx);

  return plugin.tool.autopilot.execute(args);
}

async function runNonAutopilotCommand() {
  const plugin = await AutopilotPlugin({ config: {} });
  const output = { parts: [{ type: 'text', text: 'existing command text' }] };

  await plugin['command.execute.before'](
    { command: 'other', arguments: 'off' },
    output,
  );

  return output.parts.map((part) => part.text).join('\n');
}

async function runCommandWithPlugin(plugin, argumentsText) {
  const output = { parts: [] };

  await plugin['command.execute.before'](
    { command: 'autopilot', arguments: argumentsText },
    output,
  );

  return output.parts.map((part) => part.text).join('\n');
}

test('autopilot off disables instead of starting a task', async () => {
  const text = await runAutopilotCommand('off');

  assert.match(text, /Autopilot status: stopped/);
  assert.doesNotMatch(text, /AUTOPILOT MODE ENABLED/);
});

test('autopilot resume resumes instead of starting a task named resume', async () => {
  const text = await runAutopilotCommand('resume');

  assert.match(text, /Autopilot status: resume requested/);
  assert.doesNotMatch(text, /Task: resume/);
});

test('loop count is clamped to safe range', async () => {
  const low = await runAutopilotCommand('--loops 0 create x');
  const high = await runAutopilotCommand('--loops 999 create x');

  assert.match(low, /Loop budget: 1/);
  assert.match(high, /Loop budget: 30/);
});

test('loops flag works after the task text too', async () => {
  const text = await runAutopilotCommand('create x --loops 7');

  assert.match(text, /Task: create x/);
  assert.match(text, /Loop budget: 7/);
});

test('command prompt does not tell agent to call autopilot tool again', async () => {
  const text = await runAutopilotCommand('--loops 3 create x');

  assert.doesNotMatch(text, /Call autopilot tool/i);
  assert.doesNotMatch(text, /call the `autopilot` tool/i);
});

test('tool loop count is clamped to safe range', async () => {
  const low = await runAutopilotTool({ task: 'create x', maxLoops: -5 });
  const float = await runAutopilotTool({ task: 'create x', maxLoops: 2.9 });
  const high = await runAutopilotTool({ task: 'create x', maxLoops: 999 });

  assert.match(low, /Loop budget: 1/);
  assert.match(float, /Loop budget: 2/);
  assert.match(high, /Loop budget: 30/);
});

test('tool rejects empty task instead of enabling autopilot', async () => {
  const text = await runAutopilotTool({ task: '   ', maxLoops: 5 });

  assert.match(text, /Usage: \/autopilot/);
  assert.doesNotMatch(text, /AUTOPILOT MODE ENABLED/);
});

test('malformed loops flags show usage instead of becoming tasks', async () => {
  const missingTask = await runAutopilotCommand('--loops 5');
  const invalidNumber = await runAutopilotCommand('--loops abc create x');
  const suffixInvalidNumber = await runAutopilotCommand('create x --loops nope');

  assert.match(missingTask, /Usage: \/autopilot/);
  assert.match(invalidNumber, /Usage: \/autopilot/);
  assert.match(suffixInvalidNumber, /Usage: \/autopilot/);
  assert.doesNotMatch(missingTask, /AUTOPILOT MODE ENABLED/);
  assert.doesNotMatch(invalidNumber, /AUTOPILOT MODE ENABLED/);
  assert.doesNotMatch(suffixInvalidNumber, /AUTOPILOT MODE ENABLED/);
});

test('empty args show usage', async () => {
  const text = await runAutopilotCommand('');

  assert.match(text, /Usage: \/autopilot/);
  assert.doesNotMatch(text, /AUTOPILOT MODE ENABLED/);
});

test('status reports current plugin state', async () => {
  const text = await runAutopilotCommand('status');

  assert.match(text, /Autopilot status: off/);
  assert.match(text, /Active task: none/);
});

test('off state suppresses automatic tool activation', async () => {
  const plugin = await AutopilotPlugin({ config: {} });

  await plugin['command.execute.before'](
    { command: 'autopilot', arguments: 'off' },
    { parts: [] },
  );
  const text = await plugin.tool.autopilot.execute({ task: 'create x', maxLoops: 5 });

  assert.match(text, /Autopilot status: disabled/);
  assert.doesNotMatch(text, /AUTOPILOT MODE ENABLED/);
});

test('starting a command re-enables autopilot after off', async () => {
  const plugin = await AutopilotPlugin({ config: {} });
  const offOutput = { parts: [] };
  const startOutput = { parts: [] };

  await plugin['command.execute.before']({ command: 'autopilot', arguments: 'off' }, offOutput);
  await plugin['command.execute.before']({ command: 'autopilot', arguments: 'create x' }, startOutput);

  const text = startOutput.parts.map((part) => part.text).join('\n');
  assert.match(text, /AUTOPILOT MODE ENABLED/);
  assert.match(text, /Task: create x/);
});

test('custom default loop config is honored for supported context shapes', async () => {
  const pluginCtxText = await runAutopilotCommand('create x', { plugin: { autopilot: { defaultMaxLoops: 4 } } });
  const configCtxText = await runAutopilotCommand('create x', { config: { autopilot: { defaultMaxLoops: 6 } } });
  const toolText = await runAutopilotTool({ task: 'create x' }, { config: { autopilot: { defaultMaxLoops: 8 } } });

  assert.match(pluginCtxText, /Loop budget: 4/);
  assert.match(configCtxText, /Loop budget: 6/);
  assert.match(toolText, /Loop budget: 8/);
});

test('non-autopilot commands pass through untouched', async () => {
  const text = await runNonAutopilotCommand();

  assert.equal(text, 'existing command text');
});

test('resume updates loop state for status in the same plugin instance', async () => {
  const plugin = await AutopilotPlugin({ config: {} });

  await runCommandWithPlugin(plugin, 'create x --loops 3');
  await runCommandWithPlugin(plugin, 'resume --loops 9');
  const status = await runCommandWithPlugin(plugin, 'status');

  assert.match(status, /Autopilot status: on/);
  assert.match(status, /Active task: create x/);
  assert.match(status, /Loop budget: 9/);
});

test('resume restores last task after off without losing loop state', async () => {
  const plugin = await AutopilotPlugin({ config: {} });

  await runCommandWithPlugin(plugin, 'create x --loops 4');
  await runCommandWithPlugin(plugin, 'off');
  const offStatus = await runCommandWithPlugin(plugin, 'status');
  const resumePrompt = await runCommandWithPlugin(plugin, 'resume');
  const resumedStatus = await runCommandWithPlugin(plugin, 'status');

  assert.match(offStatus, /Autopilot status: off/);
  assert.match(offStatus, /Active task: create x/);
  assert.match(offStatus, /Loop budget: 4/);
  assert.match(resumePrompt, /Loop budget: 4/);
  assert.match(resumedStatus, /Autopilot status: on/);
  assert.match(resumedStatus, /Active task: create x/);
  assert.match(resumedStatus, /Loop budget: 4/);
});

test('resume prompt reports explicit loop override when provided', async () => {
  const plugin = await AutopilotPlugin({ config: {} });

  await runCommandWithPlugin(plugin, 'create x --loops 4');
  const resumePrompt = await runCommandWithPlugin(plugin, 'resume --loops 8');

  assert.match(resumePrompt, /Loop budget: 8/);
});

test('quoted control words are treated as literal task text', async () => {
  const off = await runAutopilotCommand('"off"');
  const resume = await runAutopilotCommand('"resume"');
  const status = await runAutopilotCommand('"status"');
  const prefixedOff = await runAutopilotCommand('--loops 5 "off"');
  const suffixedResume = await runAutopilotCommand('"resume" --loops 7');
  const prefixedStatus = await runAutopilotCommand('--loops 3 "status"');

  assert.match(off, /AUTOPILOT MODE ENABLED/);
  assert.match(off, /Task: off/);
  assert.match(resume, /AUTOPILOT MODE ENABLED/);
  assert.match(resume, /Task: resume/);
  assert.match(status, /AUTOPILOT MODE ENABLED/);
  assert.match(status, /Task: status/);
  assert.match(prefixedOff, /AUTOPILOT MODE ENABLED/);
  assert.match(prefixedOff, /Task: off/);
  assert.match(prefixedOff, /Loop budget: 5/);
  assert.match(suffixedResume, /AUTOPILOT MODE ENABLED/);
  assert.match(suffixedResume, /Task: resume/);
  assert.match(suffixedResume, /Loop budget: 7/);
  assert.match(prefixedStatus, /AUTOPILOT MODE ENABLED/);
  assert.match(prefixedStatus, /Task: status/);
  assert.match(prefixedStatus, /Loop budget: 3/);
});

test('quoted literal task may contain --loops text', async () => {
  const text = await runAutopilotCommand('"investigate --loops parsing behavior"');

  assert.match(text, /AUTOPILOT MODE ENABLED/);
  assert.match(text, /Task: investigate --loops parsing behavior/);
  assert.match(text, /Loop budget: 10/);
  assert.doesNotMatch(text, /Usage: \/autopilot/);
});

test('unmatched quoted control words show usage instead of control action', async () => {
  const off = await runAutopilotCommand('"off');
  const resume = await runAutopilotCommand('"resume');
  const status = await runAutopilotCommand('"status');
  const prefixedOff = await runAutopilotCommand('--loops 5 "off');
  const trailingOff = await runAutopilotCommand('off"');
  const mixedResume = await runAutopilotCommand('"resume\'');
  const suffixStatus = await runAutopilotCommand('status" --loops 5');

  assert.match(off, /Usage: \/autopilot/);
  assert.match(resume, /Usage: \/autopilot/);
  assert.match(status, /Usage: \/autopilot/);
  assert.match(prefixedOff, /Usage: \/autopilot/);
  assert.match(trailingOff, /Usage: \/autopilot/);
  assert.match(mixedResume, /Usage: \/autopilot/);
  assert.match(suffixStatus, /Usage: \/autopilot/);
  assert.doesNotMatch(off, /Autopilot status: stopped/);
  assert.doesNotMatch(resume, /Autopilot status: resume requested/);
  assert.doesNotMatch(status, /Active task:/);
  assert.doesNotMatch(prefixedOff, /Autopilot status: stopped/);
  assert.doesNotMatch(trailingOff, /Autopilot status: stopped/);
  assert.doesNotMatch(mixedResume, /Autopilot status: resume requested/);
  assert.doesNotMatch(suffixStatus, /Active task:/);
});

test('prompt and superpowers contract prevent double activation', async () => {
  const text = await runAutopilotCommand('create x');

  assert.match(text, /AUTOPILOT MODE ENABLED/);
  assert.match(text, /Do not call the autopilot tool again/);
});

test('repo and global autopilot plugins keep command behavior in parity', async (t) => {
  if (!existsSync(globalPluginPath)) {
    t.skip('global autopilot plugin is not installed on this machine');
    return;
  }

  const repoPlugin = await AutopilotPlugin({ config: {} });
  const { AutopilotPlugin: GlobalAutopilotPlugin } = await import(pathToFileURL(globalPluginPath));
  const globalPlugin = await GlobalAutopilotPlugin({ config: {} });

  for (const args of ['--loops 5 create x', '"off"', '"off', 'status']) {
    const repoText = await runCommandWithPlugin(repoPlugin, args);
    const globalText = await runCommandWithPlugin(globalPlugin, args);

    assert.equal(globalText, repoText, `global plugin drifted for: ${args}`);
  }
});
