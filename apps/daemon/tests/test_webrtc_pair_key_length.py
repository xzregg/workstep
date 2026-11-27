import pytest


@pytest.mark.asyncio
async def test_generated_and_rotated_keys_are_32_url_safe_characters(tmp_path):
    from services.webrtc_p2p.client import WebRtcClientService
    from tests.test_webrtc_p2p_settings import _InMemoryConfigStore
    from workstep_gateway_protocol.webrtc import valid_pair_key

    service = WebRtcClientService(config_store=_InMemoryConfigStore(), config_dir_provider=lambda: tmp_path)
    first = (await service.get_settings())["pair_key"]
    second = (await service.rotate_pair_key())["pair_key"]
    assert first != second
    assert len(first) == len(second) == 32
    assert valid_pair_key(first) and valid_pair_key(second)


@pytest.mark.asyncio
async def test_weak_saved_key_is_replaced_but_valid_existing_key_is_preserved(tmp_path):
    from services.webrtc_p2p.client import WebRtcClientService, _hash_pair_key
    from tests.test_webrtc_p2p_settings import _InMemoryConfigStore

    for key in ("short", "a" * 24):
        store = _InMemoryConfigStore()
        store.data['webrtc_p2p'] = {'pair_key': key, 'pair_key_salt': 'salt', 'pair_key_verifier': _hash_pair_key(key, 'salt')}
        service = WebRtcClientService(config_store=store, config_dir_provider=lambda: tmp_path)
        saved = (await service.get_settings())["pair_key"]
        assert (saved == key) is (len(key) >= 24)
        assert service.verify_pair_key(saved)
        assert not service.verify_pair_key('short')
