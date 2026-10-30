# ChatGPT provider — origin and licence

The files in this directory are a port of the third-party plugin
[openfox-chatgpt](https://github.com/arthurlacoste/openfox-chatgpt), MIT © 2026 Arthur Lacoste.
The upstream LICENSE is kept verbatim next to this file. Like every plugin, this code runs
in-process with the server, so it is as trusted as the server itself.

MorrisCode ships it built in: the ChatGPT Plus / Pro tile appears in the provider dialog with
nothing to install.

Changes MorrisCode made, listed so a future re-sync stays reviewable:

- relative imports instead of the `openfox/provider` package specifier;
- credentials live in `{configDirectory}/credentials/chatgpt/` rather than in the plugin directory;
- the models.dev family filter no longer freezes a model generation: it used to reject every id
  that did not start with `gpt-5`, which silently hid newer models. `catalog/models-dev.test.ts`
  pins the corrected behaviour;
- the User-Agent identifies as `morriscode`;
- registration goes through BuiltInProviderPlugin instead of the plugin loader.

The provider talks to private, undocumented ChatGPT endpoints (auth.openai.com and
chatgpt.com/backend-api/codex). They can change without notice, and using them is outside the
official API. The root AGENTS.md records that this is a deliberate choice.
