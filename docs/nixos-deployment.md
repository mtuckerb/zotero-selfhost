# NixOS deployment guide

This guide shows a concrete deployment layout for running `zotero-selfhost` on NixOS with the integrated MySQL, Redis, Memcached, OpenSearch, MinIO, and nginx stack provided by this repository.

## What this module gives you

When `services.zotero-selfhost.enable = true;` and `services.zotero-selfhost.infrastructure.enable = true;`, the module provisions:

- Zotero dataserver
- Zotero stream server
- Zotero TinyMCE clean server
- MySQL
- Redis
- Memcached
- OpenSearch
- MinIO
- nginx reverse proxy

Default public hostnames are:

- `zotero.tuckerbradford.com`
- `attachments.zotero.tuckerbradford.com`

Override them in your NixOS config if needed.

## Concrete host configuration

A ready-to-adapt host example lives at:

- `examples/nixos/zotero-selfhost-host.nix`

Key points:

- import `zotero-selfhost.nixosModules.default`
- point `services.zotero-selfhost.sopsFile` at your encrypted secrets file
- set `services.zotero-selfhost.infrastructure.hostname`
- set `services.zotero-selfhost.infrastructure.attachmentsHostname`
- enable ACME/SSL if the machine is publicly reachable

## SOPS secrets layout

A deployment-oriented example lives at:

- `examples/nixos/zotero-selfhost.sops.example.yaml`

Expected keys under the default `secretPrefix = "zotero-selfhost"`:

- `zotero-selfhost/auth-salt`
- `zotero-selfhost/superuser-password`
- `zotero-selfhost/mysql-password`
- `zotero-selfhost/s3-access-key`
- `zotero-selfhost/s3-secret-key`
- `zotero-selfhost/attachment-proxy-secret`

Suggested meanings:

- `auth-salt`: long random string
- `superuser-password`: initial admin password for the API superuser
- `mysql-password`: MySQL password for the configured Zotero DB user
- `s3-access-key`: MinIO root/access key
- `s3-secret-key`: MinIO secret key
- `attachment-proxy-secret`: long random secret used by attachment proxying

## First deployment steps

1. Add DNS records for your chosen hostnames.
2. Encrypt your secrets file with SOPS.
3. Deploy with `nixos-rebuild switch --flake ...`.
4. Run `zotero-selfhost-init` on the target host.
5. Create the initial API superuser with the credentials from your SOPS secrets.
6. Optionally create additional users with:

   `zotero-selfhost-create-user UID username password email`

## Recommended smoke test checklist

After first boot, verify:

- `systemctl status zotero-selfhost`
- `systemctl status zotero-selfhost-stream`
- `systemctl status zotero-selfhost-tinymce`
- `systemctl status zotero-selfhost-minio`
- `systemctl status mysql`
- `systemctl status redis-zotero-selfhost`
- `systemctl status memcached`
- `systemctl status opensearch`
- `systemctl status nginx`

Then check:

- `https://<zotero-host>/`
- `https://<zotero-host>/stream/`
- `https://<attachments-host>/`

## Notes

- The integrated stack is convenient for a single-host deployment.
- For larger deployments, you may want to disable `services.zotero-selfhost.infrastructure.enable` and point the service at external MySQL, Redis, OpenSearch, object storage, or proxy infrastructure.
- This repository currently validates at NixOS evaluation time. Real-world runtime testing is still recommended on your target machine.
