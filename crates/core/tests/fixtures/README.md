# Golden fixtures

The `expected` files record what aitrack 4.x produced, so 5.0 stays byte-compatible with it. The
`generate*.ts` scripts that wrote them import the 4.x TypeScript library, which is no longer in the
tree. To regenerate one, check out the `v4.2.0` tag, copy the script into the same path there and run
it with `node --import tsx <script>`. The same holds for `apps/opentrack/tests/fixtures/generate.ts`,
which needs the 4.x sidecar.

They are not part of any check.
