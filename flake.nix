{
  description = "Zotero Selfhost with a NixOS service module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, sops-nix, ... }: {
    checks = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
      reader-tts = nixpkgs.legacyPackages.${system}.callPackage ./nix/reader-tts-tests.nix { };
    });
    nixosModules.default = {
      imports = [
        sops-nix.nixosModules.sops
        ./nix/module.nix
      ];
    };
    nixosModules.zotero-selfhost = self.nixosModules.default;
  };
}
