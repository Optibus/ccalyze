---
description: Put the bundled ccalyze CLI on your PATH (symlink, no npm needed)
---

Install the `ccalyze` command onto the user's PATH using the self-contained CLI
bundled with this plugin. No npm, no clone, no build — the bundle is plain
dependency-free JavaScript.

Steps:

1. If `command -v ccalyze` already resolves, tell the user it's already installed
   (show the path and `ccalyze --version`) and stop.
2. The bundled CLI lives at `${CLAUDE_PLUGIN_ROOT}/skills/ccalyze/bin/cli.js`.
   Verify it runs: `node "${CLAUDE_PLUGIN_ROOT}/skills/ccalyze/bin/cli.js" --version`.
3. Pick the install dir: `~/.local/bin` if it exists or can be created, else ask.
   Symlink it:

   ```bash
   mkdir -p ~/.local/bin
   ln -sf "${CLAUDE_PLUGIN_ROOT}/skills/ccalyze/bin/cli.js" ~/.local/bin/ccalyze
   ```

4. If `~/.local/bin` is not on the user's PATH, say so and show the line to add
   to their shell rc — do not edit their rc file without asking.
5. Verify: `ccalyze --version` (or `~/.local/bin/ccalyze --version` if PATH not
   yet reloaded) and report the version.

Note: the plugin cache is version-stamped, so the symlink pins the plugin
version installed right now — after a plugin update, tell the user to re-run
`/ccalyze:install-cli` to repoint it. If the user uninstalls the plugin, the
symlink dangles — removing it is `rm ~/.local/bin/ccalyze`.
