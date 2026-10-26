# Audio model contract

Speech-emotion, naturalness (MOS) and prosody models are heavy, GPU-friendly and replaced often, so
they run as a separate service behind one HTTP call. Any stack can implement it, for example a
speech-emotion recogniser for valence and arousal plus a MOS predictor such as UTMOS.

Set `AUDIO_MODEL_URL=https://audio-models.internal` and the worker calls it once per call that has a
recording. If the service is down or returns an error, the call is still scored with the
transcript-side emotion metrics and a warning is logged.

## Request

`POST {AUDIO_MODEL_URL}/analyze`, `multipart/form-data`:

| Part | Content |
| --- | --- |
| `audio` | The recording as the provider serves it (WAV or MP3; stereo when the provider has it) |
| `meta` | JSON, below |

```json
{
  "call_id": "conv_01",
  "channels": 2,
  "agent_channel": 0,
  "turns": [
    { "idx": 0, "speaker": "agent", "start": 0.0, "end": 4.1, "tags": ["warmly"] },
    { "idx": 1, "speaker": "caller", "start": 4.6, "end": 6.0, "tags": [] }
  ]
}
```

`tags` are the delivery tags the agent's LLM wrote into its text (`[warmly]`, `[confidently]`), so
the service can check the voice actually delivered them. Timeouts: 5 minutes per call.

## Response

```json
{
  "usable": true,
  "model": "ser-v3+utmos-22",
  "consistency_ok": true,
  "turns": [
    { "idx": 0, "arousal": 0.42, "mos": 4.1, "monotone": false, "artefacts": 0, "tag_match": true, "wpm": 158 },
    { "idx": 1, "valence": -0.35, "arousal": 0.61 }
  ]
}
```

Every field except `usable` and `turns[].idx` is optional; a metric is scored only from the fields
present.

| Field | Range | Feeds |
| --- | --- | --- |
| `usable` | boolean | `false` (noise, silence, wrong file) skips audio metrics for the call |
| `turns[].valence` (caller turns) | −1 … 1 | Caller emotion trajectory; frustration events (with rising `arousal`) |
| `turns[].arousal` | 0 … 1 | Frustration events; over-dramatisation when the agent's arousal exceeds the caller's by > 0.3 |
| `turns[].mos` (agent turns) | 1 … 5 | Naturalness (mean over agent turns) |
| `turns[].monotone` (agent) | boolean | Intonation variety (share of monotone turns) |
| `turns[].tag_match` (agent) | boolean | Delivery-tag fidelity |
| `turns[].artefacts` (agent) | count | Audio artefacts (glitches, clipping, robotic segments) |
| `turns[].wpm` (agent) | words/min | Speaking rate (median) |
| `consistency_ok` | boolean | Voice consistency across the call |
