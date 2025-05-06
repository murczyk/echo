{
  inputs = {
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "nixpkgs/nixos-unstable";
  };

  outputs = {self, fenix, flake-utils, nixpkgs}:
    flake-utils.lib.eachDefaultSystem (system: {
      packages.default = let
        toolchain = fenix.packages.${system}.minimal;
        pkgs = nixpkgs.legacyPackages.${system};
      in
        pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            # Rust
            opencv
            toolchain.rustc
            toolchain.cargo
            (rustPlatform.buildRustPackage {
              pname = "sea-orm-cli";
              version = "0.12.12";

              src = fetchCrate {
                pname = "sea-orm-cli";
                version = "0.12.12";
                hash = "sha256-WcEPuGqXaUwrapaDi621uAiKk8GKBrsipOq5owJnJz8=";
              };

              nativeBuildInputs = [ pkg-config ];

              buildInputs = [ openssl ];
              cargoHash = "sha256-la27eNUgrBa1/GGwgdZBLH0tbBbT96LgTXn5IKmlF78=";
            })
            libxlsxwriter
            cargo-watch
            llvmPackages.bintools
            pkg-config
            clang
            proj
            openssl
            # Elm
            elmPackages.elm
            elmPackages.elm-test
            elmPackages.elm-format
            nodejs_21 # deno?
            # Justfile
            just
            # Python
            python3
            python311Packages.pip
            zlib
            # Sidecars
            podman
            podman-compose
            postgresql
          ];

          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
          LD_LIBRARY_PATH = "${pkgs.stdenv.cc.cc.lib.outPath}/lib:${pkgs.zlib}/lib";

          shellHook = with pkgs; ''
            export BINDGEN_EXTRA_CLANG_ARGS="$(< ${stdenv.cc}/nix-support/libc-crt1-cflags) \
              $(< ${stdenv.cc}/nix-support/libc-cflags) \
              $(< ${stdenv.cc}/nix-support/cc-cflags) \
              $(< ${stdenv.cc}/nix-support/libcxx-cxxflags) \
              ${lib.optionalString stdenv.cc.isClang "-idirafter ${stdenv.cc.cc}/lib/clang/${lib.getVersion stdenv.cc.cc}/include"} \
              ${lib.optionalString stdenv.cc.isGNU "-isystem ${stdenv.cc.cc}/include/c++/${lib.getVersion stdenv.cc.cc} -isystem ${stdenv.cc.cc}/include/c++/${lib.getVersion stdenv.cc.cc}/${stdenv.hostPlatform.config} -idirafter ${stdenv.cc.cc}/lib/gcc/${stdenv.hostPlatform.config}/${lib.getVersion stdenv.cc.cc}/include"} \
            "
          '';
        };
    });
}
