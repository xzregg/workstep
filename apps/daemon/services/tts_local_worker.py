"""Sentence synthesis adapters. All inference and media I/O run in this worker."""

import base64
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import uuid
import wave
from contextlib import contextmanager, redirect_stdout
from pathlib import Path

MAX_WAV = 24 * 1024 * 1024
OMNI_REPO = 'aufklarer/OmniVoice-MLX-int8'


@contextmanager
def child(command, env=None):
    proc = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=sys.stderr, text=True, encoding='utf-8')
    try:
        yield proc
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        proc.stdout.close()


@contextmanager
def cosyvoice(bundle, runtime, references):
    env = {**os.environ, 'DYLD_LIBRARY_PATH': str(runtime)}
    with child([runtime / 'cosyvoice3_server', '--supervised', '--model-kind', 'cosyvoice3',
                '--model-directory', bundle, '--host', '127.0.0.1', '--port', '0',
                '--allowed-local-media-path', references], env) as proc:
        ready = json.loads(proc.stdout.readline())
        if ready.get('event') != 'ready':
            raise ValueError('CosyVoice3 failed to initialize')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def generate(request):
            body = dict(input=request['text'], response_format='wav')
            if request.get('reference'):
                body['ref_audio'] = request['reference']
            if request['instructions']:
                body['instructions'] = request['instructions']
            elif request.get('reference_text'):
                body['ref_text'] = request['reference_text']
            reply = urllib.request.Request(f"http://127.0.0.1:{int(ready['port'])}/v1/audio/speech",
                json.dumps(body, ensure_ascii=False).encode(), {'Content-Type': 'application/json'})
            with opener.open(reply, timeout=100) as response:
                return response.read(MAX_WAV + 1)

        yield generate


@contextmanager
def omnivoice(bundle, runtime, working):
    cache = working / 'qwen3-speech/models/aufklarer'
    cache.mkdir(parents=True)
    (cache / 'OmniVoice-MLX-int8').symlink_to(bundle, target_is_directory=True)
    env = {**os.environ, 'QWEN3_CACHE_DIR': str(working), 'HOME': str(working),
           'CFFIXED_USER_HOME': str(working)}
    with child([runtime / 'soniqo-tts-sidecar'], env) as proc:
        def call(command, **fields):
            identifier = uuid.uuid4().hex
            proc.stdin.write(json.dumps(dict(id=identifier, command=command, engine='omnivoice',
                                            modelId=OMNI_REPO, **fields), ensure_ascii=False) + '\n')
            proc.stdin.flush()
            reply = json.loads(proc.stdout.readline())
            if reply.get('id') != identifier or not reply.get('ok'):
                raise ValueError('OmniVoice synthesis or initialization failed')
            return identifier, reply['result']

        call('init_model')

        def generate(request):
            tone = request['instructions'] or 'neutral'
            text = f"({tone}) {request['text']}"
            identifier, result = call('synthesize_omnivoice', text=text, language='zh',
                referenceAudioPath=request['reference'], referenceText=request.get('reference_text') or None)
            path = Path(result['audioPath']).resolve()
            if path.name != f'{identifier}.wav' or not path.is_relative_to(working):
                raise ValueError('OmniVoice returned an invalid audio path')
            try:
                with path.open('rb') as audio:
                    return audio.read(MAX_WAV + 1)
            finally:
                path.unlink(missing_ok=True)

        yield generate


class OmniVoiceSpeaker:
    """Keep one bounded, in-memory speaker prompt instead of redesigning each chunk."""

    PROMPT = '你好，很高兴和你交流。我们慢慢说。'

    def __init__(self, model, mx):
        self.model, self.mx = model, mx
        self.style = None
        self.tokens = None

    def generate(self, request):
        text = request['text']
        language = 'zh' if re.search(r'[\u3400-\u9fff]', text) else 'en'
        reference = request.get('reference')
        if reference:
            options = {'ref_audio': reference, 'ref_text': request.get('reference_text') or None}
        else:
            style = request['instructions']
            if self.tokens is None or self.style != style:
                # A constant prompt fixes speaker identity independently of reply wording.
                self.mx.random.seed(1)
                audio = self.mx.concatenate([result.audio.reshape(-1) for result in self.model.generate(
                    text=self.PROMPT, language='zh', instruct=style, num_steps=16)])
                tokens = self.model.audio_tokenizer.encode(audio[None, :, None])[0]
                self.mx.eval(tokens)
                self.style, self.tokens = style, tokens
            options = {'ref_tokens': self.tokens, 'ref_text': self.PROMPT}
        # Bound diffusion attention memory; every chunk uses the same real speaker prompt.
        for start in range(0, len(text), 80):
            self.mx.random.seed(1)
            yield from self.model.generate(text=text[start:start + 80], language=language,
                                           instruct=request['instructions'], num_steps=16, **options)


@contextmanager
def omnivoice_design(bundle, runtime):
    sys.path.insert(0, str(runtime))
    import mlx.core as mx
    import numpy as np
    from mlx_audio.tts.models.omnivoice.omnivoice import Model
    from mlx_audio.tts.utils import load_model

    class SwiftWeightsModel(Model):
        def sanitize(self, weights):
            weights = dict(weights)
            # The shared INT8 checkpoint packs scales and biases for all codebooks.
            for layer in ('audio_embeddings', 'audio_heads'):
                for suffix in ('scales', 'biases'):
                    packed = weights.pop(f'{layer}.{suffix}', None)
                    if packed is not None:
                        for index, block in enumerate(mx.split(packed, self.config.num_audio_codebook)):
                            weights[f'{layer}.{index}.{suffix}'] = block
            return super().sanitize(weights)

    mx.set_cache_limit(128 * 1024**2)
    # load_model resolves the OmniVoice class from mlx-audio's model registry.
    from mlx_audio.tts.models import omnivoice as family
    original = family.Model
    family.Model = SwiftWeightsModel
    try:
        model = load_model(str(bundle))
    finally:
        family.Model = original

    speaker = OmniVoiceSpeaker(model, mx)

    def generate(request):
        samples = [np.asarray(result.audio, dtype=np.float32) for result in speaker.generate(request)]
        pcm = np.concatenate(samples).clip(-1, 1)
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setparams((1, 2, model.sample_rate, 0, 'NONE', ''))
            wav.writeframes((pcm * 32767).astype('<i2').tobytes())
        return output.getvalue()

    yield generate


@contextmanager
def moss(bundle):
    sys.path.insert(0, str(bundle / 'runtime'))
    sys.path.insert(0, str(Path(__file__).with_name('_moss_nano')))
    import numpy as np
    import sentencepiece
    from ort_cpu_runtime import OrtCpuRuntime

    runtime = OrtCpuRuntime(bundle, thread_count=4, max_new_frames=300)
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(
        runtime.resolve_manifest_relative_path(runtime.manifest['model_files']['tokenizer_model'])))
    settings = runtime.codec_meta['codec_config']
    rate = settings['sample_rate']
    presets = {voice['voice']: voice['prompt_audio_codes'] for voice in runtime.list_builtin_voices()}
    cached_path = None
    cached_codes = None

    def reference_codes(path):
        nonlocal cached_path, cached_codes
        if path == cached_path:
            return cached_codes
        with wave.open(path, 'rb') as audio:
            source_rate = audio.getframerate()
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2')
            channels = samples.reshape(-1, audio.getnchannels()).astype(np.float32).T / 32768
        if channels.shape[0] == 1:
            channels = np.repeat(channels, settings['channels'], axis=0)
        if source_rate != rate:
            old = np.arange(channels.shape[1])
            new = np.arange(round(channels.shape[1] * rate / source_rate)) * source_rate / rate
            channels = np.stack([np.interp(new, old, channel) for channel in channels]).astype(np.float32)
        encoder = runtime.sessions['codec_encode']
        values = encoder.run(None, {'waveform': channels[None, :, :],
            'input_lengths': np.asarray([channels.shape[-1]], dtype=np.int32)})
        named = {item.name: value for item, value in zip(encoder.get_outputs(), values, strict=True)}
        cached_codes = named['audio_codes'][0, :named['audio_code_lengths'].item()].tolist()
        cached_path = path
        return cached_codes

    def generate(request):
        reference = reference_codes(request['reference']) if request['voice'] == 'reference' else presets[request['voice']]
        tokens = tokenizer.encode(request['text'], out_type=int)
        # WorkStep ordinarily submits sentences. Cap token length for long unpunctuated input.
        audio = []
        for offset in range(0, len(tokens), 60):
            rows = runtime.build_voice_clone_request_rows(reference, tokens[offset:offset + 60])
            frames = runtime.generate_audio_frames(rows)
            channels, _ = runtime.decode_full_audio(frames)
            audio.append(np.stack(channels, axis=-1).clip(-1, 1))
        samples = np.concatenate(audio)
        target = io.BytesIO()
        with wave.open(target, 'wb') as output:
            output.setparams((samples.shape[1], 2, rate, 0, 'NONE', ''))
            output.writeframes((samples * 32767).astype('<i2').tobytes())
        return target.getvalue()

    yield generate


def main():
    model, bundle, root = sys.argv[1:4]
    bundle, root = Path(bundle).resolve(), Path(root).resolve()
    output = sys.stdout
    design_runtime = (Path(sys.argv[sys.argv.index('--design-runtime') + 1])
                      if '--design-runtime' in sys.argv[4:] else None)
    with tempfile.TemporaryDirectory(prefix='workstep-tts-') as temp, redirect_stdout(sys.stderr):
        runtime = root / 'model-runtimes' / model
        adapters = {'moss-nano': lambda: moss(bundle),
                    'cosyvoice3': lambda: cosyvoice(bundle, runtime, root / 'references'),
                    'omnivoice': lambda: omnivoice(bundle, runtime, Path(temp).resolve())}
        adapter = omnivoice_design(bundle, design_runtime) if design_runtime is not None else adapters[model]()
        with adapter as generate:
            if '--check' in sys.argv[4:]:
                return
            for line in sys.stdin:
                try:
                    data = generate(json.loads(line))
                    if len(data) > MAX_WAV:
                        raise ValueError('Audio is too large')
                    with wave.open(io.BytesIO(data), 'rb') as audio:
                        if not audio.getnframes():
                            raise ValueError('Audio is empty')
                        rate = audio.getframerate()
                    print(json.dumps(dict(audio=base64.b64encode(data).decode(), format='wav',
                                          sample_rate=rate)), file=output, flush=True)
                    print('{"done":true}', file=output, flush=True)
                except Exception as exc:
                    print(str(exc), file=sys.stderr, flush=True)
                    print('{"error":"synthesis_failed","done":true}', file=output, flush=True)


if __name__ == '__main__':
    main()
