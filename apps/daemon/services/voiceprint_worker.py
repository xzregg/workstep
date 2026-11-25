"""Isolated CPU speaker embedding worker, using the installed speech runtime."""
import base64
import json
import sys


def main():
    sys.path.insert(0, sys.argv[1])
    import numpy as np
    import sherpa_onnx

    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=sys.argv[2], num_threads=2, provider='cpu'))
    if '--check' in sys.argv:
        return
    for line in sys.stdin:
        try:
            request = json.loads(line)
            samples = np.frombuffer(base64.b64decode(request['audio'], validate=True), dtype='<i2').astype(np.float32) / 32768
            # Remove quiet frames before counting enrollment/verification speech.
            # This is a quality check; normal recording uses the existing Silero VAD.
            frames = samples[:len(samples)//320*320].reshape(-1, 320)
            voiced = frames[np.sqrt(np.mean(frames**2, axis=1)) >= .008].reshape(-1)
            if len(samples) and np.mean(np.abs(samples) >= .99) > .2:
                raise ValueError('clipped audio')
            embedding = []
            if len(voiced) >= 16000:
                stream = extractor.create_stream()
                stream.accept_waveform(sample_rate=16000, waveform=voiced)
                stream.input_finished()
                if extractor.is_ready(stream):
                    embedding = np.asarray(extractor.compute(stream)).tolist()
            text = json.dumps({'embedding': embedding, 'voiced_samples': len(voiced)})
            result = {'session_id': request['session_id'], 'text': text}
        except Exception:
            result = {'error': 'voiceprint_failed'}
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
