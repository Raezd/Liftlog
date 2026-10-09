"""Settings come from environment variables (set in .env, passed in by Compose).
The app refuses to start if a required secret is missing."""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    # Shared secret that Caddy attaches to every request it forwards. The backend
    # rejects anything without it, so the only way in is through Caddy, which
    # only listens inside the Tailscale container.
    proxy_secret: str = Field(min_length=32)
    # Comma-separated Tailscale logins allowed to use the app.
    allowed_logins: str

    @field_validator("allowed_logins")
    @classmethod
    def at_least_one_login(cls, v: str) -> str:
        if not [x for x in v.split(",") if x.strip()]:
            raise ValueError("ALLOWED_LOGINS must list at least one Tailscale login")
        return v

    @property
    def allowed_login_set(self) -> frozenset[str]:
        return frozenset(x.strip().lower() for x in self.allowed_logins.split(",") if x.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
