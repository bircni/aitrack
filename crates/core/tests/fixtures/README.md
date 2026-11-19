# Golden fixtures

The `expected` files record what aitrack 4.x produced, so 5.0 stays byte-compatible with it. The
scripts that wrote them imported the 4.x TypeScript library and were removed with it; git history
keeps them at the same paths.

4.x also read Cursor. Its cases are gone, and the `usage` and `display` outputs that carried a
Cursor section were written again without it by the 5.0 code that matched the recordings.
