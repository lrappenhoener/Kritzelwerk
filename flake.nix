{
  description = "Kritzelwerk development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      runtimeLibs = with pkgs; [
        webkitgtk_4_1
        gtk3
        libsoup_3
        libappindicator-gtk3
        librsvg
        openssl
        glib
        cairo
        pango
        gdk-pixbuf
        atk
        harfbuzz
        dbus
        libGL
        xz
      ];
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = runtimeLibs ++ (with pkgs; [
          nodejs_24
          cargo
          rustc
          rustfmt
          clippy
          pkg-config
          rust-analyzer
          gsettings-desktop-schemas
        ]);

        shellHook = ''
          export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeLibs}:''${LD_LIBRARY_PATH:-}"
          export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:''${XDG_DATA_DIRS:-}"
          export WEBKIT_DISABLE_DMABUF_RENDERER=1
          export WEBKIT_DISABLE_COMPOSITING_MODE=1
        '';
      };
    };
}
