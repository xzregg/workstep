"""Engine-owned configuration rules and storage adapters.

Modules use an injected store (get/set); importing them never loads an engine,
SDK, registry or the global config singleton. New engines own their settings
without adding methods to services.config.
"""
