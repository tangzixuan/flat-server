// v1 binding phone controller tests are skipped because importing
// BindingPhone / SendMessage triggers heavy imports via PhoneSMS config ->
// alibaba cloud Dysmsapi SDK, which exceeds ava 4's worker thread memory
// limit (JS heap OOM).
//
// The blacklist check logic in both controllers is identical:
//   await new UserBlacklistService(this.req.ids, dataSource.manager).assertNotBanned({
//       phone,
//   });
//
// This exact pattern is already covered by:
//   1. src/v2/services/user/__tests__/blacklist.test.ts (assertNotBanned with phone)
//   2. src/v2/services/user/__tests__/rebind-phone.test.ts (sendMessage and rebind
//      both call assertNotBanned({ phone }) - tests blacklisted phone rejected
//      for sendMessage, rebind, and target userUUID blacklist)
//
// If the ava worker memory issue is resolved in the future, these tests can be
// enabled. See docs/design/2026-07-06-WB-432-user-blacklist.md section 7.

import test from "ava";

const namespace = "[api][api-v1][api-v1-user-binding-phone]";

test.skip(`${namespace} - send message to blacklisted phone rejected`, async () => {
    // See comment above: OOM when importing SendMessage (PhoneSMS -> alibaba SDK).
});

test.skip(`${namespace} - bind blacklisted phone rejected`, async () => {
    // See comment above: OOM when importing BindingPhone (PhoneSMS -> alibaba SDK).
});
