# Regenerate the CLI demo GIF in the README.
#
#   brew install vhs
#   cargo build -p keymaker-cli    # or: cargo install --path crates/keymaker-cli
#   vhs scripts/demo.tape          # run from the repository root
#
# The recording never touches the store: every command shown reads or writes
# files only, so it runs against any machine without keychain prompts.

Output docs/images/keymaker-cli.gif

Set Shell "zsh"
Set FontFamily "Fira Code"
Set FontSize 17
Set LineHeight 1.5
Set Padding 24
Set Width 760
Set Height 380
Set Framerate 30
Set TypingSpeed 60ms
Set CursorBlink true
Set Theme { "Background": "#0d0d0d", "Foreground": "#ededed", "Cursor": "#3b82f6", "Selection": "#22355c", "Black": "#1e2430", "Red": "#f87171", "Green": "#4ade80", "Yellow": "#f38020", "Blue": "#60a5fa", "Purple": "#c084fc", "Cyan": "#22d3ee", "White": "#ededed", "BrightBlack": "#8a8a8a", "BrightRed": "#fca5a5", "BrightGreen": "#86efac", "BrightYellow": "#fdba74", "BrightBlue": "#93c5fd", "BrightPurple": "#d8b4fe", "BrightCyan": "#67e8f9", "BrightWhite": "#ffffff" }

Hide
Type "export PATH=$PWD/target/debug:$PATH"
Enter
Type "rm -rf /tmp/keymaker-tape-demo && cp -R scripts/demo-env /tmp/keymaker-tape-demo && cd /tmp/keymaker-tape-demo"
Enter
Type "export PS1='$ '"
Enter
Type "clear"
Enter
Show

Sleep 1000ms
Type "keymaker get stripe/sk_live"
Enter
Sleep 2000ms

Type "keymaker list -e production"
Enter
Sleep 3000ms

Type "keymaker run -- ./scripts/migrate.sh"
Enter
Sleep 2600ms
Type "y"
Enter
Sleep 2800ms

Type "keymaker audit --verify"
Enter
Sleep 3500ms
