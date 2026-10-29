// Entry for the vendored browser build of the official Anthropic SDK
// (src/static/vendor/anthropic-sdk.js, global MemoAnthropicSdk). memo-ai-client.js
// loads it on the first Claude request; the app stays no-bundler otherwise.
export { default as Anthropic } from '@anthropic-ai/sdk';
