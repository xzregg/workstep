"""Qwen's public API produces a complete sentence; never advertise frame streaming."""
import base64
from contextlib import redirect_stdout
import json
import os
import sys


def load(bundle):
    import torch
    from qwen_tts import Qwen3TTSModel
    torch.set_num_threads(2)
    # CPU is the portable baseline. Apple Metal is used when available; CUDA
    # wheels are deliberately not downloaded into the baseline CPU runtime.
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    dtype = torch.float32
    return Qwen3TTSModel.from_pretrained(str(bundle), device_map=device, dtype=dtype,
        attn_implementation='sdpa', local_files_only=True)


def synthesize(model, request):
    import numpy as np
    import librosa
    args = dict(text=request['text'], language='Auto', max_new_tokens=2048)
    kind = model.model.tts_model_type
    if kind == 'voice_design':
        wavs, sr = model.generate_voice_design(**args, instruct=request['instructions'])
    else:
        wavs, sr = model.generate_custom_voice(**args, speaker=request['voice'],
            instruct=request.get('instructions') or None)
    samples = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
    if sr != 24000:
        samples = librosa.resample(samples, orig_sr=sr, target_sr=24000)
    return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()


def main():
    # These settings are private to the worker; synthesis cannot silently fetch
    # missing weights or tokenizer files after installation.
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      TOKENIZERS_PARALLELISM='false', PYTORCH_ENABLE_MPS_FALLBACK='1')
    sys.path.insert(0, sys.argv[2])
    with redirect_stdout(sys.stderr):
        model = load(sys.argv[1])
    if '--check' in sys.argv:
        return
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with redirect_stdout(sys.stderr):
                pcm = synthesize(model, request)
            for offset in range(0, len(pcm), 32768):
                print(json.dumps(dict(audio=base64.b64encode(pcm[offset:offset + 32768]).decode(),
                                      format='pcm', sample_rate=24000)), flush=True)
            print('{"done":true}', flush=True)
        except Exception:
            print('{"error":"synthesis_failed","done":true}', flush=True)


if __name__ == '__main__':
    main()
