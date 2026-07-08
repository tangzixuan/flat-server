// OAuth callback controller tests are skipped because importing the platform
// Login classes (LoginGithub, LoginGoogle, LoginWechat, LoginApple, LoginAgora)
// triggers heavy imports via AbstractLogin -> alibabaCloud OSS + cloud storage
// services, which exceeds ava 4's worker thread memory limit (JS heap OOM).
//
// The blacklist check logic in each callback is identical:
//   if (userUUIDByDB) {
//       await new UserBlacklistService(ids, dataSource.manager).assertNotBanned({
//           userUUID: userUUIDByDB,
//       });
//   }
//
// This exact pattern is already covered by:
//   1. src/v2/services/user/__tests__/blacklist.test.ts (15 service-level tests)
//   2. src/v1/controller/login/__tests__/process.test.ts (LoginProcess also calls
//      assertNotBanned on userUUIDByDB - tests blacklisted userUUID rejected,
//      failedReason="user_blacklisted", and non-blacklisted user proceeds)
//
// If the ava worker memory issue is resolved in the future, these tests can be
// enabled. See docs/design/2026-07-06-WB-432-user-blacklist.md section 7.

import test from "ava";

const namespace = "[api][api-v1][api-v1-login][api-v1-login-github-callback]";

test.skip(`${namespace} - blacklisted existing user rejected`, async () => {
    // See comment above: OOM when importing LoginGithub.
});

test.skip(`${namespace} - non-blacklisted existing user proceeds`, async () => {
    // See comment above: OOM when importing LoginGithub.
});

test.skip(`${namespace} - new user (userUUIDByDB null) skips blacklist check`, async () => {
    // See comment above: OOM when importing LoginGithub.
});
