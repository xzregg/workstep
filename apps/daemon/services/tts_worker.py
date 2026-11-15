"""Private CPU TTS worker. No project text or generated audio is persisted."""
import base64
import json
import sys
from pathlib import Path


def main():
    bundle = Path(sys.argv[1])
    sys.path.insert(0, str(bundle / 'runtime'))
    import numpy as np
    import sherpa_onnx

    kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=str(bundle / 'model.onnx'), voices=str(bundle / 'voices.bin'),
        tokens=str(bundle / 'tokens.txt'), data_dir=str(bundle / 'espeak-ng-data'),
        lexicon=','.join(str(bundle / name) for name in ['lexicon-us-en.txt', 'lexicon-zh.txt']),
        dict_dir=str(bundle / 'dict'))
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=2, provider='cpu'),
        rule_fsts=','.join(str(bundle / name) for name in ['date-zh.fst', 'number-zh.fst']),
        max_num_sentences=1))
    if '--check' in sys.argv:
        return

    def emit(value):
        print(json.dumps(value), flush=True)

    for line in sys.stdin:
        try:
            request = json.loads(line)
            def callback(samples, progress):
                pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
                for offset in range(0, len(pcm), 32768):
                    emit(dict(audio=base64.b64encode(pcm[offset:offset + 32768]).decode(),
                              format='pcm', sample_rate=tts.sample_rate))
                return 1
            tts.generate(request['text'], sid=int(request['voice']), speed=request['rate'], callback=callback)
            emit({'done': True})
        except Exception:
            emit({'error': 'synthesis_failed', 'done': True})


if __name__ == '__main__':
    main()
