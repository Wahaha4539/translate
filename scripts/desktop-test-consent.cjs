'use strict';
if (process.env.HUANYI_ALLOW_DESKTOP_TESTS !== '1') {
  throw new Error('桌面测试会打开窗口并可能抢焦点。仅在用户明确同意后设置 HUANYI_ALLOW_DESKTOP_TESTS=1；后台检查请运行 npm test 或 npm run test:headless。');
}
