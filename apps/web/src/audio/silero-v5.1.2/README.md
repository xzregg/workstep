# Silero VAD v5.1.2

Upstream model: https://github.com/snakers4/silero-vad/tree/v5.1.2/src/silero_vad/data

`silero_vad.onnx` SHA-256: `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`

The DSP worker uses the upstream 16 kHz interface with 512 new samples,
64 history samples and recurrent state per capture. See the upstream
`utils_vad.py` at the same tag and the MIT license in `public/assets/voice-licenses/`. The same directory contains the ONNX Runtime Web 1.22.0 license and third-party notices.
