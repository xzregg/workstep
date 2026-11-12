"""Private JSONL inference worker. All downloads are forbidden here."""
import contextlib
import json
import os
import sys


def main():
    sys.path.insert(0, sys.argv[1])
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', USE_TF='0', TOKENIZERS_PARALLELISM='false')
    # Bound native CPU fan-out before importing numerical libraries.
    os.environ.update(OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
                      VECLIB_MAXIMUM_THREADS='1', NUMEXPR_NUM_THREADS='1')
    if hasattr(os, 'nice'):
        try:
            os.nice(10)
        except OSError:
            pass
    # Third-party diagnostics must never corrupt the protocol stream.
    protocol = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        import laya
        import torch
        import transformers
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        if '--check' in sys.argv:
            return
        model = laya.load(sys.argv[2], device='cpu', backend='eager')
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = model.system_one(request['state'], request['questions'])
            protocol.write(json.dumps({'id': request['id'], 'result': result}, ensure_ascii=False) + '\n')
            protocol.flush()
        except Exception:
            protocol.write(json.dumps({'error': '本地决策推理失败'}) + '\n')
            protocol.flush()


if __name__ == '__main__':
    main()
