# Why the agent stopped answering, and why the sidebar stayed empty

> Code Companion v5.5.0, against the v5.4.0 export

Two symptoms reported together — a prompt that sat on "Working on
it..." forever, and a conversation list that never filled — with two
unrelated causes.

## 1. The agent never answered: `msg.query` was deleted

The v4.6.2 baseline is the only version of this application observed
answering a prompt in production. It always gave the Enabler **both**
inputs:

```js
msg.query = cleanQuestion;   // the question
msg.messages = [ ... ];      // the structured turns
```

v5.4.0 removed the first, in two places, reasoning:

> Enabler accepts msg.messages OR msg.query. This flow intentionally
> uses the structured msg.messages contract, so do not leave a second
> competing query input on the message.

That is an assumption about the module's contract, not an observation of
it. The `enabler-llm` node exposes only `model`, `slug` and `projectid`
— there is no input-property setting that would let anyone confirm which
field it reads. And it is the **only** change to what the model is given
between the version that answers and the version that does not:

| | `msg.query` reaching the Enabler |
| --- | --- |
| v4.6.2 (answers) | `"Which SAP tables are recommended for the report?"` |
| v5.4.0 (silent) | *deleted, twice* |

Both deletions are reverted. `msg.messages` is untouched, so if the
Enabler does prefer the structured form it still gets it — sending both
costs nothing and is what the working version did.

Note how this failed: silently. Nothing errored, so nothing reached the
catch node, so no error was ever shown. The turn simply stopped.

## 2. The sidebar stayed empty: three separate reasons

### a) Persistence only ran after a successful reply

`Prepare Conversation Persist` was tapped off `Extract Response + Update
Chat` — i.e. after the model answered. With the model never answering,
no conversation was ever written. The symptom was downstream of cause 1
and would have vanished with it, but the design is still wrong: a slow
or failed turn should not cost the user their history.

It now also runs from `Prepare Enabler Request`, so **the conversation
exists the moment the prompt is sent**. `nosql-persist` upserts by
`_id`, so the write after the reply updates the same document.

That required one more change. At send time `data.messagesJson` holds
only what was already on screen — the greeting — while the question the
user just typed is on `msg.userQuestion`. Persisting as-is would have
titled every conversation after the greeting, which is identical for
all of them. `CVP-01B` appends the pending turn first, so the title is
the user's own words.

### b) An unresolved user identity discarded the write

```js
const ownerUserId = scaUserId(msg);

if (!ownerUserId) {
  /* Never persist a shared "anonymous" history. */
  return null;
}
```

`scaUserId` searches some thirty candidate locations on the message. The
privacy intent is right — pooling everyone under `"anonymous"` would
show one person's conversations to another — but discarding the write is
not the only way to honour it.

The owner now falls back to a value the browser supplies
(`conversationOwner`, SCA-40), in order of preference:

1. an identity the page already exposes to script;
2. the signed-in name the platform shell renders in its header;
3. a random id kept in `localStorage` for this browser profile.

Only (1) is an authenticated identity. **(2) and (3) are separators, not
credentials** — they keep one person's conversations away from
another's, which is what the sidebar needs, and they authorise nothing.
If all three fail, the original behaviour stands: nothing is written,
and nothing is pooled.

### c) The sidebar searched under a different owner

`Prepare Conversation List Query` resolved the owner with `scaUserId`
alone. Had (b) been fixed on its own, conversations would have been
written under the browser-supplied owner and listed under
`"__unresolved_authenticated_user__"` — every write succeeding, the
sidebar still empty. Both sides now use the same fallback, and a test
asserts they agree rather than checking each in isolation.

## The Form.io contract that made this subtle

The first attempt at `conversationOwner` declared it as a `hidden`
component, beside `conversationId` and the other hidden state. It did
not work, and looked like it did:

| Component type | `setFormField` writes the DOM | Value reaches the submission |
| --- | --- | --- |
| `textarea` (`messagesJson`) | yes | **yes** |
| `hidden` (`conversationId`) | yes | **no** |

The controller's `setFormField()` sets the input's value and dispatches
`input`/`change`, which is how every state field already reaches the
flow. A Form.io `hidden` component ignores that entirely — the DOM shows
the right value and `form.submission.data` stays empty.

`conversationOwner` is therefore modelled on `messagesJson`: a
`textarea` carrying the `sca-state-field` class, hidden by the same CSS
as the other state fields. `tests/owner-browser.test.js` asserts the
value reaches `form.submission.data` rather than merely appearing in the
DOM.

## Also restored

`Prepare RAG Ingestion` called `require("crypto")` at top level again —
this was removed in v5.2.0 and came back in the v5.4.0 lineage. A
Node-RED function sandbox does not define `require` unless the
deployment enables external modules, and the chat path runs through this
node on every message. It was used for one hash, now inlined.

## Verification

| Suite | Covers |
| --- | --- |
| `tests/chat-path.test.js` | 17 assertions: the Enabler contract compared directly against the v4.6.2 baseline; a conversation produced at send time with a title from the user's question; owner fallback and the no-identity case; persist and list agreeing on the owner. Executed without `require`, as the sandbox does. |
| `tests/owner-browser.test.js` | 6 assertions in real Form.io: the field binds, the browser resolves an owner, the value reaches the submission, and it is stable across renders. |

**What these cannot cover**: the Enabler node itself. No aXet runtime
was available, so "sending `msg.query` makes it answer" rests on the
v4.6.2 baseline's behaviour, not on an observed call. If a prompt still
goes unanswered after this, the Node-RED debug output from
`Prepare Enabler Request` (it logs the request shape) is the next thing
to look at.
