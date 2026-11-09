"""Private streaming JSONL worker, launched with -I and an isolated runtime."""
import base64
import json
import sys
from pathlib import Path


class StreamingDecoder:
    """Keep acoustic/decoder state for one recording, and reset on ownership change."""

    def __init__(self, recognizer, punctuate=None):
        self.recognizer = recognizer
        self.punctuate = punctuate or (lambda text: text)
        self.session_id = None
        self.stream = None
        self.prefix = ''

    @staticmethod
    def join(left, right):
        space = bool(left and right and left[-1].isascii() and left[-1].isalnum()
                     and right[0].isascii() and right[0].isalnum())
        return left + (' ' if space else '') + right

    def feed(self, session_id, samples, final):
        if self.session_id != session_id:
            self.stream = self.recognizer.create_stream()
            self.session_id = session_id
            self.prefix = ''
        self.stream.accept_waveform(16000, samples)
        if final:
            # Drain the model's lookahead/cache without waiting for real silence.
            self.stream.accept_waveform(16000, [0.0] * 12800)
            self.stream.input_finished()
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        partial = self.recognizer.get_result(self.stream).strip()
        endpoint = not final and self.recognizer.is_endpoint(self.stream)
        if partial and (final or endpoint):
            partial = self.punctuate(partial)
        text = self.join(self.prefix, partial)
        if final:
            self.session_id = None
            self.stream = None
            self.prefix = ''
        elif endpoint:
            self.prefix = text
            self.recognizer.reset(self.stream)
        return text


def main():
    bundle = Path(sys.argv[1])
    sys.path.insert(0, str(bundle / 'runtime'))
    import numpy as np
    import sherpa_onnx

    recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
        tokens=str(bundle / 'tokens.txt'), encoder=str(bundle / 'encoder.int8.onnx'),
        decoder=str(bundle / 'decoder.int8.onnx'), num_threads=2, provider='cpu',
        enable_endpoint_detection=True,
    )
    punctuator = None
    punctuation_path = bundle / 'punctuation.int8.onnx'
    if punctuation_path.is_file():
        punctuator = sherpa_onnx.OfflinePunctuation(sherpa_onnx.OfflinePunctuationConfig(
            model=sherpa_onnx.OfflinePunctuationModelConfig(
                ct_transformer=str(punctuation_path), num_threads=1, provider='cpu')))
    punctuate = punctuator.add_punctuation if punctuator else None
    if '--check' in sys.argv:
        if punctuate:
            punctuate('你好这是一条测试')
        return
    decoder = StreamingDecoder(recognizer, punctuate)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            samples = np.frombuffer(base64.b64decode(request['audio'], validate=True), dtype='<i2').astype(np.float32) / 32768
            result = {'session_id': request['session_id'], 'text': decoder.feed(request['session_id'], samples, request['final'])}
        except Exception:
            decoder = StreamingDecoder(recognizer, punctuate)
            result = {'error': 'recognition_failed'}
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
