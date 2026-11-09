from services.speech_worker import StreamingDecoder


class Stream:
    def __init__(self):
        self.samples = []
        self.pending = False
        self.finished = False
        self.text = ''

    def accept_waveform(self, rate, samples):
        assert rate == 16000
        self.samples.extend(samples)
        self.pending = True

    def input_finished(self):
        self.finished = True


class Recognizer:
    def __init__(self):
        self.streams = []
        self.endpoint = False

    def create_stream(self):
        stream = Stream()
        self.streams.append(stream)
        return stream

    def is_ready(self, stream):
        return stream.pending

    def decode_stream(self, stream):
        stream.pending = False
        stream.text = '最终词' if stream.finished else '临时词'

    def get_result(self, stream):
        return stream.text

    def is_endpoint(self, stream):
        return self.endpoint

    def reset(self, stream):
        stream.text = ''


def test_incremental_audio_keeps_one_decoder_and_final_drains_it():
    recognizer = Recognizer()
    decoder = StreamingDecoder(recognizer)
    assert decoder.feed('first', [1] * 8000, False) == '临时词'
    assert decoder.feed('first', [2] * 8000, True) == '最终词'
    assert len(recognizer.streams) == 1
    stream = recognizer.streams[0]
    assert stream.samples == [1] * 8000 + [2] * 8000 + [0] * 12800
    assert stream.finished
    assert decoder.stream is None


def test_new_recording_discards_cancelled_stream_and_endpoint_prefix():
    recognizer = Recognizer()
    recognizer.endpoint = True
    decoder = StreamingDecoder(recognizer)
    assert decoder.feed('cancelled', [1], False) == '临时词'
    assert decoder.feed('cancelled', [2], False) == '临时词临时词'
    assert decoder.feed('new', [3], True) == '最终词'
    assert len(recognizer.streams) == 2
    assert recognizer.streams[1].samples[0] == 3


def test_english_endpoint_boundaries_keep_word_spacing():
    assert StreamingDecoder.join('hello', 'world') == 'hello world'
    assert StreamingDecoder.join('你好', '世界') == '你好世界'


def test_punctuation_runs_only_at_endpoint_and_final_and_never_on_silence():
    calls = []
    def punctuate(text):
        calls.append(text)
        return text + '。'
    recognizer = Recognizer()
    decoder = StreamingDecoder(recognizer, punctuate)
    assert decoder.feed('a', [1], False) == '临时词'
    assert calls == []
    recognizer.endpoint = True
    assert decoder.feed('a', [2], False) == '临时词。'
    recognizer.endpoint = False
    assert decoder.feed('a', [3], True) == '临时词。最终词。'
    assert calls == ['临时词', '最终词']
    recognizer.get_result = lambda stream: ''
    assert decoder.feed('b', [], True) == ''
    assert len(calls) == 2
