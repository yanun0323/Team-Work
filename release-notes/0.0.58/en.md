## Fixes

- Adding an OpenAI-compatible provider no longer fails with "model list format is incorrect" when the server describes each model's features as a simple list of names, as some local model servers do. If the server lists the thinking levels a model supports, you can now pick from them too.
