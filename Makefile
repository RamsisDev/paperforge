# Desktop installers for macOS, Windows and Linux. Run `make` for the list of targets.
# Installers end up in release/<target-triple>/.
#
# Each platform builds best on itself; from elsewhere:
#   - macOS installers need a Mac (or `make ci`);
#   - Windows from macOS or Linux is cross-compiled with cargo-xwin, NSIS installer only
#     (`make windows-tools` installs what it needs);
#   - Linux from macOS or Windows builds inside Docker, on Ubuntu 22.04 like CI, so the AppImage
#     runs on older distributions too.

ifeq ($(OS),Windows_NT)
  HOST := windows
  ARCH := x86_64
else
  HOST := $(if $(filter Darwin,$(shell uname -s)),mac,linux)
  ARCH := $(patsubst arm64,aarch64,$(shell uname -m))
endif

MAC_ARM := aarch64-apple-darwin
MAC_INTEL := x86_64-apple-darwin
WINDOWS := x86_64-pc-windows-msvc
LINUX_X64 := x86_64-unknown-linux-gnu
LINUX_ARM := aarch64-unknown-linux-gnu

RELEASE := release
NODE_MODULES := node_modules/.package-lock.json
TEX_CACHE := src-tauri/resources/tex-cache/formats
LINUX_IMAGE := paperforge-linux-build
VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null)

.DEFAULT_GOAL := help
.PHONY: help deps tex-cache mac mac-arm mac-intel windows windows-tools linux linux-x64 linux-arm64 \
	linux-native linux-docker all ci clean

help:
	@echo "PaperForge installers (this machine: $(HOST) $(ARCH))"
	@echo ""
	@echo "  make mac            macOS .dmg, Apple Silicon and Intel (needs a Mac)"
	@echo "  make mac-arm        macOS .dmg, Apple Silicon only"
	@echo "  make mac-intel      macOS .dmg, Intel only"
	@echo "  make windows        Windows: .msi + .exe on Windows; .exe cross-compiled elsewhere"
	@echo "  make windows-tools  installs cargo-xwin, NSIS and LLVM to cross-compile for Windows"
	@echo "  make linux          Linux x64 .AppImage, .deb, .rpm (native on Linux, else Docker)"
	@echo "  make linux-arm64    Linux arm64 .AppImage, .deb, .rpm"
	@echo "  make all            every installer this machine can build"
	@echo "  make ci             every installer, on GitHub Actions"
	@echo "  make clean          removes release/"
	@echo ""
	@echo "Installers are copied to $(RELEASE)/<target>/."

$(NODE_MODULES): package-lock.json
	npm ci

deps: $(NODE_MODULES)

# Platform independent: warmed once with this machine's sidecars, bundled into every installer
# so the app typesets offline.
$(TEX_CACHE): | $(NODE_MODULES)
	npm run sidecars
	npm run warm-tex-cache

tex-cache: $(TEX_CACHE)

# $(call build,<target-triple>,<extra tauri build args>,<environment prefix>)
define build
	npm run sidecars -- $(1)
	rustup target add $(1)
	$(3) npm run tauri -- build --target $(1) $(2)
	@mkdir -p $(RELEASE)/$(1)
	@find src-tauri/target/$(1)/release/bundle -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*-setup.exe' \
		-o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) ! -name 'rw.*' -exec cp {} $(RELEASE)/$(1)/ \;
	@echo "Installers in $(RELEASE)/$(1)/:" && ls -1 $(RELEASE)/$(1)
endef

# $(call docker-build,<target-triple>,<docker platform>)
# node_modules and target/ live in volumes: the host's hold binaries for the host's platform.
define docker-build
	docker build --platform $(2) -t $(LINUX_IMAGE):$(1) -f docker/linux.Dockerfile docker
	docker run --rm --platform $(2) \
		-v "$(CURDIR)":/app \
		-v paperforge-$(1)-node-modules:/app/node_modules \
		-v paperforge-$(1)-target:/app/src-tauri/target \
		-v paperforge-$(1)-cargo:/usr/local/cargo/registry \
		-e APPIMAGE_EXTRACT_AND_RUN=1 \
		-w /app $(LINUX_IMAGE):$(1) make linux-native TARGET=$(1)
endef

mac: mac-arm mac-intel

# Tauri builds the .app; the .dmg is made here from a folder, without mounting it: Tauri's
# script mounts the image to arrange it in Finder, and recent macOS fails to unmount it.
mac-arm mac-intel: deps tex-cache
	@[ "$(HOST)" = mac ] || { echo "macOS installers need a Mac; use 'make ci' to build them on GitHub."; exit 1; }
	$(eval TRIPLE := $(if $(filter mac-arm,$@),$(MAC_ARM),$(MAC_INTEL)))
	$(call build,$(TRIPLE),--bundles app)
	$(eval STAGE := src-tauri/target/$(TRIPLE)/release/bundle/dmg-stage)
	@rm -rf $(STAGE) && mkdir -p $(STAGE)
	ditto src-tauri/target/$(TRIPLE)/release/bundle/macos/PaperForge.app $(STAGE)/PaperForge.app
	ln -s /Applications $(STAGE)/Applications
	hdiutil create -volname PaperForge -srcfolder $(STAGE) -ov -format UDZO \
		$(RELEASE)/$(TRIPLE)/PaperForge_$(VERSION)_$(if $(filter mac-arm,$@),aarch64,x64).dmg
	@rm -rf $(STAGE)
	@ls -1 $(RELEASE)/$(TRIPLE)

ifeq ($(HOST),windows)
windows: deps tex-cache
	$(call build,$(WINDOWS))
else
LLVM_BIN := $(shell brew --prefix llvm 2>/dev/null)/bin
windows: deps tex-cache
	@command -v cargo-xwin >/dev/null && command -v makensis >/dev/null || \
		{ echo "Cross-compiling for Windows needs cargo-xwin, NSIS and LLVM: run 'make windows-tools'."; exit 1; }
	$(call build,$(WINDOWS),--runner cargo-xwin --bundles nsis,PATH="$(LLVM_BIN):$$PATH")
endif

windows-tools:
ifeq ($(HOST),mac)
	brew install nsis llvm
else ifeq ($(HOST),linux)
	@echo "Install NSIS, LLVM, clang and lld with your package manager, e.g.:"
	@echo "  sudo apt install nsis llvm clang lld"
else
	@echo "On Windows nothing extra is needed: 'make windows' builds natively."
endif
ifneq ($(HOST),windows)
	cargo install --locked cargo-xwin
	rustup target add $(WINDOWS)
endif

linux: linux-x64

linux-x64 linux-arm64: deps tex-cache
	$(eval TRIPLE := $(if $(filter linux-x64,$@),$(LINUX_X64),$(LINUX_ARM)))
	$(eval PLATFORM := $(if $(filter linux-x64,$@),linux/amd64,linux/arm64))
ifeq ($(HOST),linux)
	@if [ "$(TRIPLE)" = "$(ARCH)-unknown-linux-gnu" ]; then $(MAKE) linux-native TARGET=$(TRIPLE); \
	else $(MAKE) linux-docker TRIPLE=$(TRIPLE) PLATFORM=$(PLATFORM); fi
else
	@$(MAKE) linux-docker TRIPLE=$(TRIPLE) PLATFORM=$(PLATFORM)
endif

linux-docker:
	@command -v docker >/dev/null || { echo "Building for Linux here needs Docker."; exit 1; }
	$(call docker-build,$(TRIPLE),$(PLATFORM))

# Inside the Linux build container, or on Linux itself.
linux-native: deps tex-cache
	$(call build,$(TARGET))

ifeq ($(HOST),mac)
all: mac windows linux
else ifeq ($(HOST),windows)
all: windows linux
else
all: windows linux
endif

ci:
	gh workflow run build.yml --ref $$(git branch --show-current)
	@sleep 3 && gh run list --workflow build.yml --limit 1
	@echo "Follow it with: gh run watch   ·   installers: gh run download <run-id>"

clean:
	rm -rf $(RELEASE)
