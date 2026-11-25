# Digital hub voice

Read the digital hub voice and available local model voices:

```bash
<cli> digital-hub voice list --json
```

Use only IDs returned by that command, from a model with `available: true`:

```bash
<cli> digital-hub voice set --model <model_id> --voice <voice_id> --json
```

Native tools: `workstep_list_digital_hub_voices`, then `workstep_select_digital_hub_voice` with
`voice`, optional `model_id`, and `confirm: "yes"`.

Changing voice requires the user's request and host scope. `--model` explicitly
switches output to that local model; omit it to keep the current local model.
This reuses the digital hub Voice page's existing shared output settings; saved
changes also apply to message read-aloud across clients.
Stop playback first if the service reports busy. Do not download models or
change credentials to work around an unavailable voice.

System voices are supplied by the playback device and cannot be enumerated by
this host tool. Cloud/remote voice selection remains in Digital hub → Voice;
this tool selects installed local models only. If no model is available, report
that limitation and direct the user to the existing digital-hub voice settings.
