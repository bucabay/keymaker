# Biometric protection on macOS

Per-item protection in the Data Protection Keychain, with a vault so **one**
authorization opens **every** protected value.

## The vault model

Two layers, both in `crates/seal-keychain`:

- **Per-item access control.** A protected item accepts either USER_PRESENCE
  (Touch ID or the device password, one prompt per read) **or** the
  APPLICATION_PASSWORD — a random vault key created once per service, itself
  stored under a USER_PRESENCE access control.
- **One authorization, many reads.** `unlock` reads the vault key — the one
  Touch ID prompt — and the GUI holds the key for the rest of the session.
  Every reveal after that rebuilds a LocalAuthentication context on the
  calling thread, presents the key as the credential, and reads silently. The
  key bytes are the only state that is shared, so no authentication object
  ever crosses threads.

Reading without the vault still works: the item's USER_PRESENCE half prompts
per item. That is the fallback for a single read, and the recovery path if the
vault key item is ever deleted.

## Status — November 2026

**Not verified on device.** The code paths are complete and the architecture
is what a signed build would exercise, but no macOS provisioning profile
exists for this project (expired Developer Program memberships; the cached
profiles authorize iOS, not native macOS — seal's
[BIOMETRICS.md](https://github.com/bucabay/seal/blob/main/docs/BIOMETRICS.md)
holds the full signing investigation). Unsigned builds are refused by macOS
with `errSecMissingEntitlement` (-34018), and on that error **alone** keymaker
falls back to the standard keychain — every other failure is surfaced, so no
other condition silently downgrades where a value rests.

Until a provisioned build exists, biometric protection stays deactivated in
practice: the store writes standard keychain items, the GUI shows no biometric
badges for them, and the unlock button reports that there is no vault yet.

## Activation

1. A valid **macOS** provisioning profile authorizing the app identifier
   `dev.bucabay.keymaker` with `keychain-access-groups` entitlements, signed
   with a live Apple Development identity.
2. Sign and provision the GUI (and the CLI and broker, which share the store)
   with the shared group.
3. Run the one test that proves the model:

   ```sh
   cargo test -p seal-keychain -- --ignored --nocapture \
     one_unlock_authorizes_every_protected_item
   ```

   It creates a vault key, protects two items, unlocks once, and reads both
   silently — one authorization, many reads.

## Limits

- The vault key is never shown and never written anywhere but the keychain.
  If its item is deleted, protected values can no longer be unlocked
  together; each still reads through its own USER_PRESENCE prompt.
- Items protected under earlier builds (USER_PRESENCE-only access controls)
  keep prompting per read until they are saved again under the new policy.
- The jail is unaffected: biometrics protect values at rest from other
  processes; the agent jail stops the agent reaching the store at all.
