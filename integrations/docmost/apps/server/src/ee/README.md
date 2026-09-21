This directory is an empty placeholder.

Docmost Enterprise Edition lives in a private repo (`https://github.com/docmost/ee`)
that this project cannot access and must not vendor.

The open-source server already treats missing EE modules as optional
(see `license-check.service.ts`). Wiki features used by mind-map do not
depend on this folder.

Do not restore `integrations/docmost/.gitmodules` pointing at `docmost/ee`.
That nested submodule is why `git pull origin main` tried to fetch a private repo.
