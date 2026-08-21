# The chat path: retrieval, FAQ, and why a turn must never be lost

> Code Companion v5.2.0

## What went wrong in v5.1.0

v5.1.0 added retrieval-augmented generation and, in doing so, rewired
the chat path from

```
SAP Chat Request -> Validate + Build SAP Agent Prompt -> Code Agent LLM
```

to

```
SAP Chat Request -> Prepare RAG Ingestion -> [nosql-persist]
                 -> Prepare RAG Retrieval Query -> [nosql-query]
                 -> BM25 Rank -> Validate + Build SAP Agent Prompt -> LLM
```

Every message — including a plain "hi" with nothing attached — now
needed a resolvable user identity and two NoSQL round-trips before it
could reach the model. Two nodes treated a miss as fatal:

```js
// Prepare RAG Ingestion
if (!userId) {
  node.error("RAG ingestion requires an authenticated aXet user identity.", msg);
  return [null, null];        // <- discards the message
}

// Prepare RAG Retrieval Query
if (!userId || !conversationId) {
  node.error("RAG retrieval could not resolve userId/conversationId.", msg);
  return null;                // <- discards the message
}
```

Returning `null` drops the turn. The model was never called, so nothing
came back; and the raised error travelled to the catch node, through
`Check err`, to `Prepare Safe Error` — which is why an error banner
appeared at the same time. Both halves of "the agent is not working"
came from these two branches.

Worth noting for contrast: the conversation-history code shipped in
v5.0.0 resolves the *same* identity from the *same* places and falls
back to `"anonymous"`. Same problem, opposite decision.

## The rule

> **Retrieval augmentation is an enhancement to an answer, never a
> precondition for producing one.**

Everything below follows from it.

| Guard | Behaviour |
| --- | --- |
| Unresolved identity | Fall back to `"anonymous"`; chunks stay conversation-scoped, so nothing leaks between conversations. Warn, never error. |
| Nothing to retrieve | Continue with an empty candidate set. A chat with no attachments is the normal case, not a failure. |
| Any unexpected throw in a retrieval node | A fail-open wrapper forwards the message on unchanged rather than letting it reach the catch node. |
| A retrieval node reaching `Check err` anyway | `CER-01B` recognises the failing node by name, strips the error, and routes back to the prompt builder — output 1 already leads there, so this needed no new wiring. |
| The model call or prompt building failing | Still surfaces to the developer. That is a real failure and worth showing. |

The last two matter more than they look. Hardening the first two guards
made the chat path reach the retrieval `nosql-query` nodes **for the
first time** — before it, the message was discarded upstream and they
never ran. A collection that does not exist yet would otherwise have
reintroduced the same bug from one node further down.

`require("crypto")` was also removed from `Prepare RAG Ingestion`. A
Node-RED function sandbox does not define `require` unless the
deployment enables external modules, and nothing as central as the chat
path should depend on that being configured. It was used for one hash,
now two seeded FNV-1a passes.

## The FAQ layer

```
BM25 Rank + Build RAG Context
  -> Prepare FAQ Lookup
  -> Load FAQ Entries        (nosql-query, collection "sca-faqs")
  -> Match FAQ + Ground
  -> Validate + Build SAP Agent Prompt
```

Curated question/answer pairs are retrieved and ranked exactly the way
attachment chunks already are, then injected as grounding ahead of the
developer's request.

**No vector database.** The NoSQL module is confirmed present on this
platform — four nodes already use it — whereas a vector store and an
embedding endpoint are not confirmed available at all. A curated FAQ set
is tens of entries rather than millions, so lexical ranking is both
sufficient and much easier to reason about when an answer looks wrong.
If a vector store is provisioned later, `Match FAQ + Ground` is the
single node that would change.

**It never answers on the model's behalf.** A canned reply would drift
out of step with the four-stage workflow and make the assistant sound
scripted. What the FAQ contributes is a *house answer* for the model to
follow, delimited and framed as reference material — the same "data,
never instructions" framing attachments already use.

**Built-in defaults plus a collection.** The defaults ship inside the
flow, so the application answers "hi" sensibly the moment it is
imported, before anyone has created `sca-faqs`. Entries in the
collection are merged with them and ranked together, and an entry whose
`_id` matches a default's id replaces it. So it works with no setup and
stays editable in the database.

### Adding or editing an FAQ

Insert into the `sca-faqs` collection:

```json
{
  "_id": "clean-core",
  "data": {
    "question": "what is clean core clean-core principle upgrade stable",
    "answer": "Clean core means keeping S/4HANA upgrade-stable: ...",
    "tags": ["clean-core", "extensibility"]
  }
}
```

`question` is matched as a bag of terms, not as a sentence, so list the
words a developer would actually type. `tags` are matched too. Greetings
and pleasantries are matched on the whole phrase instead, because they
carry almost no lexical signal.

The built-in set covers greetings, thanks, capabilities, clean core,
released APIs, ABAP Cloud restrictions, RAP, CDS, extensibility options,
and how attachments work.

## What could not be verified

The same caveat as `CHAT-HISTORY.md`: no aXet.flows runtime or real
database was available, so the exact behaviour of `nosql-query` against
a **missing** collection is unknown. That is precisely why `CER-01B`
exists — the first thing to check after import is that a plain "hi"
answers normally, which it will whether or not `sca-faqs` has been
created.

## Verification

`tests/rag-backend.test.js` — 33 assertions executing the real node
bodies exactly as Node-RED does, deliberately **without** providing
`require`, covering: the chain carrying a plain "hi" through to a valid
model request; every fatal branch replaced; fail-open behaviour;
`Check err`'s retrieval bypass versus a genuine model failure; FAQ
matching, curated overrides, malformed entries; and that the guidance
reaches the user turn.
