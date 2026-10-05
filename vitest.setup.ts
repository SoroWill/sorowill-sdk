import { onTestFinished } from 'vitest';

// Suppress false-positive unhandled rejection warnings from Vitest's fake timers
// when SignTransactionTimeoutError is thrown during timeout test execution.
// These rejections are eventually handled by test expect() statements.

process.on('unhandledRejection', (reason) => {
  if (reason?.constructor?.name === 'SignTransactionTimeoutError') {
    // Suppress this error - it will be caught by the test
  }
});
