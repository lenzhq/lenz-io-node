---
name: Bug report
about: Report a defect in the SDK
title: '[bug] '
labels: bug
---

**Description**
What happened? What did you expect?

**Reproducer**
A minimal example, ideally runnable. Sanitize any API keys.

```ts
import { Lenz } from "lenz-io";
const client = new Lenz({ apiKey: "…" });
…
```

**Environment**
- SDK version (`npm ls lenz-io`): 
- Node version (`node --version`): 
- OS: 

**Request ID(s)**
If you saw an error, paste the `X-Request-ID` value. Helps us look up the exact server-side log.
