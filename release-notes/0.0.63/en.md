## Fixes

**Thinking levels for Gemini models on an API key**
Gemini models used to offer only "default", and any other level you set was quietly dropped. You can now pick their thinking levels, from none up to xhigh, and the level you pick is actually sent to Gemini. Not every Gemini model takes every level: Gemini lowers or turns down the ones a model doesn't support.
