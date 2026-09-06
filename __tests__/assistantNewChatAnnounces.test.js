// ─────────────────────────────────────────────────────────────────────────────
// The assistant's "+" says what it did, on both clients.
//
// One button produced two OPPOSITE bug reports, and both were the same silence:
//
//   · "The + button on AI kills the AI chat feed with no way to get it back."
//     Half true. Mid-conversation it does wipe the feed, instantly, with no warning
//     and no acknowledgement. But nothing is lost — the thread is persisted
//     server-side the moment the assistant replies, and the clock/History button
//     immediately beside it reopens the whole conversation. Verified on device
//     2026-09-06: sent a message, pressed +, opened History, restored in full.
//
//   · "The + doesn't do anything." Also true, in the other state: on an
//     already-fresh chat it sets exactly the state that is already set, so nothing
//     moves on screen.
//
// A user who believes their conversation was destroyed has lost as much trust as
// one whose conversation really was. So the button now acknowledges every press and,
// when there was something to clear, names the way back.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const mobile = strip(read('src/components/AssistantButton.js'));
const web = strip(read('web/components/AssistantWidget.tsx'));

const newChatBody = (src) => {
  const i = src.indexOf('const newChat =');
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n  };', i));
};

describe.each([
  ['mobile', mobile],
  ['web', web],
])('%s: the + acknowledges every press', (_label, src) => {
  const body = newChatBody(src);

  it('decides whether there was a conversation before clearing it', () => {
    // Order matters: reading messages.length AFTER the reset would always see 1.
    expect(body).toMatch(/hadConversation\s*=\s*messages\.length > 1 \|\| !!threadId/);
    const decide = body.indexOf('hadConversation');
    const reset = body.indexOf('setMessages([{ role');
    expect(decide).toBeLessThan(reset);
  });

  it('still clears the thread — this is a new chat, not a no-op', () => {
    expect(body).toMatch(/setThreadId\(null\)/);
    expect(body).toMatch(/setMessages\(\[\{ role/);
  });

  it('tells the user something happened, in BOTH states', () => {
    // The silent branch is the whole defect. Two distinct messages, one per state.
    expect(body).toMatch(/(showToast|setNotice)\(hadConversation/);
    expect(body).toMatch(/New chat started/);
    expect(body).toMatch(/already on a new chat|You're on a new chat|You&apos;re on a new chat/i);
  });

  it('names the way back when there WAS a conversation', () => {
    // "with no way to get it back" is the report this sentence exists to answer.
    // It must point at the control that actually recovers it, not just reassure.
    const at = Math.max(body.indexOf('showToast(hadConversation'), body.indexOf('setNotice(hadConversation'));
    const hadBranch = body.slice(at);
    expect(hadBranch).toMatch(/saved/i);
    expect(hadBranch).toMatch(/clock|History/);
  });
});

describe('the recovery path the toast promises actually exists', () => {
  it('both clients expose a History control next to the +', () => {
    expect(mobile).toMatch(/onPress=\{openHistory\}/);
    expect(mobile).toMatch(/accessibilityLabel="Past conversations"/);
    expect(web).toMatch(/onClick=\{openHistory\}/);
  });

  it('history reads real persisted threads, not local state', () => {
    expect(mobile).toMatch(/setThreads\(await listThreads\(\)\)/);
    expect(web).toMatch(/await listThreads\(\)/);
    const lib = read('src/lib/assistantThreads.js');
    expect(lib).toMatch(/export async function listThreads/);
    expect(lib).toMatch(/export async function loadThread/);
  });

  it('the thread id is captured from the server reply, so it can be reopened', () => {
    // If this stops happening the conversation really would be unrecoverable, and the
    // toast above would become a lie.
    expect(mobile).toMatch(/if \(res\.thread_id\) setThreadId\(res\.thread_id\)/);
    expect(web).toMatch(/if \(res\.thread_id\) setThreadId\(res\.thread_id\)/);
  });
});

describe('web: deleting the open thread does not point at history', () => {
  it('suppresses the toast on that path', () => {
    // The thread is gone from History too, so "open History to reopen it" would be
    // wrong. This is why newChat takes a flag rather than always announcing.
    expect(web).toMatch(/if \(id === threadId\) newChat\(false\)/);
  });

  it('the header button passes no argument, so the click event cannot become the flag', () => {
    // onClick={newChat} hands React's MouseEvent in as `announce`, which is truthy —
    // it would work by accident today and break silently the day the meaning flips.
    // tsc catches it; this keeps it caught after any refactor.
    expect(web).toMatch(/onClick=\{\(\) => newChat\(\)\}/);
    expect(web).not.toMatch(/onClick=\{newChat\}/);
  });
});

describe('mobile: the acknowledgement is rendered INSIDE the sheet', () => {
  // AchievementToast is an absolutely-positioned view in the root tree; this sheet is a
  // React Native <Modal>, a separate native window on iOS. A toast fired from here is
  // presented UNDERNEATH the sheet and the user sees nothing — zIndex does not cross
  // that boundary. Found on device after the toast version read correctly in review.
  it('uses inline state, not the app toast', () => {
    const body = newChatBody(mobile);
    expect(body).toMatch(/setNotice\(/);
    expect(body).not.toMatch(/showToast\(/);
  });

  it('renders the notice in the sheet, beside the error line', () => {
    expect(mobile).toMatch(/\{notice \? <Text style=\{styles\.noticeText\}>\{notice\}<\/Text> : null\}/);
    expect(mobile).toMatch(/noticeText: \{/);
  });

  it('clears when the user moves on, so it cannot go stale', () => {
    expect(mobile).toMatch(/const send = async[\s\S]{0,400}?setNotice\(null\)/);
    expect(mobile).toMatch(/const openHistory = async[\s\S]{0,200}?setNotice\(null\)/);
  });

  it('is NOT injected as a chat bubble', () => {
    // An assistant bubble is replayed to the model as a real assistant turn — the
    // mistake the web widget's error handling already records. A notice is chrome.
    const body = newChatBody(mobile);
    expect(body).not.toMatch(/role: 'assistant', content: (?!GREETING)/);
  });
});
