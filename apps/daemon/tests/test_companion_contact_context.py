from datetime import datetime, timedelta, timezone


def test_contact_timing_distinguishes_attempt_and_user_response():
    from services.digital_person_companion import snapshot
    now=datetime(2026,11,15,12,tzinfo=timezone.utc)
    state={'companions':{'local':{'contacts':[{'run_id':'r1','at':(now-timedelta(minutes=20)).isoformat()}],
                                'last_observed_at':(now-timedelta(minutes=10)).isoformat()}},
           'runs':[{'id':'r1','notified_at':(now-timedelta(minutes=19)).isoformat()},
                   {'id':'other','notified_at':now.isoformat()}]}
    timing=snapshot(state,'local',None,now)['contact_timing']
    assert timing['minutes_since_last_contact_attempt']==20
    assert timing['user_spoke_after_last_contact'] is True
    assert timing['minimum_interval_minutes']==5
    assert timing['last_notification_at']==(now-timedelta(minutes=19)).isoformat()
    assert snapshot(state,'other',None,now)['contact_timing']['last_contact_attempt_at'] is None


def test_notification_timestamps_survive_model_projection():
    from services.digital_person_reflection import model_context
    notice={'source_ids':['m1'],'status':'delivery_failed','attempted_at':'2026-11-15T10:00:00+00:00',
            'notified_at':None,'created_at':'2026-11-15T09:59:00+00:00','summary':'private old text'}
    result=model_context({'previous_notifications':[notice]},'p')['previous_notifications'][0]
    assert result['attempted_at']==notice['attempted_at'] and result['notified_at'] is None
    assert 'summary' not in result


def test_roleplay_guidance_connects_state_to_behavior():
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    from services.digital_person_affect import prompt
    profile=DigitalPersonProfile()
    state=dict(affinity=50,emotion='calm',valence=0,arousal=0)
    text=instruction(profile)
    assert 'EMOTION' not in text
    assert 'arousal' not in text and '"mood"' not in text
    assert 'affinity_delta' in text
    assert 'last_contact_attempt_at' in instruction(profile)
    assert '0-29' not in instruction(profile)
    assert 'program applies affinity_delta' in instruction(profile)


def test_background_assessment_does_not_request_historical_search():
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    from services.memory_query import assessment_instruction
    text=instruction(DigitalPersonProfile())+assessment_instruction('test')
    assert 'Use only this assigned batch' in text
    assert 'Search older' not in text
    assert 'reading the old knowledge' not in text
    assert 'memory pending' in text and 'complete message bodies' in text


def test_affinity_changes_interval_without_bypassing_contact_rules():
    from services.digital_person_companion import contact_interval, contact_policy
    now=datetime(2026,11,15,12,tzinfo=timezone.utc)
    assert [contact_interval(5,a) for a in (0,50,100)] == [15,10,5]
    state={'contacts':[{'at':(now-timedelta(minutes=7)).isoformat()}]}
    user=(now-timedelta(minutes=3)).isoformat()
    assert contact_policy(state,user,now,interval_minutes=contact_interval(5,100))['allowed']
    assert not contact_policy(state,user,now,interval_minutes=contact_interval(5,0))['allowed']
    assert not contact_policy(state,None,now,interval_minutes=contact_interval(5,100))['allowed']
    assert not contact_policy({'opted_out':True},user,now,interval_minutes=5)['allowed']


def test_assessment_distinguishes_unfinished_work_from_social_contact():
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    text=instruction(DigitalPersonProfile())
    assert 'waiting for user input' in text
    assert 'kind=work' in text
    assert 'independent of affinity' in text
    assert 'Distinguish message completion from task completion' in text
    assert 'Choose silent for running, cancelled, resolved or explicitly paused work' in text


def test_assessment_prompt_describes_current_actions_only():
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    from services.memory_query import assessment_instruction
    text=instruction(DigitalPersonProfile())+assessment_instruction('placeholder')
    for retired in ('mood','emotion','valence','arousal','thought','Do not','Never','never '):
        assert retired not in text
def test_experience_prompt_uses_the_persisted_outcome_contract():
    from services.digital_person import DigitalPersonProfile
    from services.digital_person_assessment import instruction
    prompt=instruction(DigitalPersonProfile())
    assert 'For experience use outcome=reported' in prompt
    assert 'all source IDs supporting the situation, action and result' in prompt
    assert 'Relation endpoints must exactly match entities[].name within the same memory' in prompt
    assert 'supersedes only for fully read knowledge IDs' in prompt
    assert 'Search summaries alone are insufficient' in prompt
