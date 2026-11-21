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


class SegmentDecoder:
    """Reuse a speculative transcript until more waveform is appended."""

    def __init__(self, decode):
        self.decode = decode
        self.session_id = None
        self.chunks = []
        self.text = None

    def feed(self, session_id, samples, final, preview=True):
        if self.session_id != session_id:
            self.session_id = session_id
            self.chunks = []
            self.text = None
        if len(samples):
            self.chunks.append(samples)
            self.text = None
        if not final and not preview:
            return ''
        if self.text is None:
            self.text = self.decode(self.chunks) if self.chunks else ''
        text = self.text
        if final:
            self.session_id = None
            self.chunks = []
            self.text = None
        return text


def main():
    bundle = Path(sys.argv[1])
    sys.path.insert(0, str(bundle / 'runtime'))
    import numpy as np
    import sherpa_onnx

    kind = sys.argv[sys.argv.index('--model-type') + 1] if '--model-type' in sys.argv else 'paraformer'
    if kind == 'sensevoice':
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(bundle / 'model.int8.onnx'), tokens=str(bundle / 'tokens.txt'),
            language='auto', use_itn=True, num_threads=2, provider='cpu',
        )

        def decode(chunks):
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, np.concatenate(chunks))
            recognizer.decode_stream(stream)
            return stream.result.text.strip()

        make_decoder = lambda: SegmentDecoder(decode)
    else:
        recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(bundle / 'tokens.txt'), encoder=str(bundle / 'encoder.int8.onnx'),
            decoder=str(bundle / 'decoder.int8.onnx'), num_threads=2, provider='cpu',
            enable_endpoint_detection=True,
        )
    punctuate = None
    if kind != 'sensevoice':
        punctuation_path = bundle / 'punctuation.int8.onnx'
        if punctuation_path.is_file():
            punctuate = sherpa_onnx.OfflinePunctuation(sherpa_onnx.OfflinePunctuationConfig(
                model=sherpa_onnx.OfflinePunctuationModelConfig(
                    ct_transformer=str(punctuation_path), num_threads=1, provider='cpu'))).add_punctuation
        make_decoder = lambda: StreamingDecoder(recognizer, punctuate)
    if '--check' in sys.argv:
        if punctuate:
            punctuate('你好这是一条测试')
        return
    decoder = make_decoder()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            samples = np.frombuffer(base64.b64decode(request['audio'], validate=True), dtype='<i2').astype(np.float32) / 32768
            args = (request['session_id'], samples, request['final'])
            text = decoder.feed(*args, request.get('preview', True)) if kind == 'sensevoice' else decoder.feed(*args)
            result = {'session_id': request['session_id'], 'text': text}
        except Exception:
            decoder = make_decoder()
            result = {'error': 'recognition_failed'}
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
