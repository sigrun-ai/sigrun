## Task 7: Slash commands

**Scope:** a command registry + the composer's `/` menu.

**Sub-tasks:**

- **T7a: The registry.** A `Map<string, SlashCommand>` where `SlashCommand = { name, description, execute(args, context) }`. The commands map to endpoint calls: `/fork` → `POST /v1/conversations/:id/fork`, `/compact` → `POST /v1/conversations/:id/compact`, etc. The registry is extensible — extensions can register commands.

- **T7b: The composer menu.** Typing `/` in the composer opens a command menu. Selecting a command executes it. Unknown commands produce a clear error. Test: `/fork` in the composer creates a fork; an unknown command errors.

**Files:** `src/server/commands.ts` (new), `webui/src/composer/Composer.tsx`.

