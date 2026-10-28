fn main() {
    // Tests locate the sidecars by target triple, the same naming Tauri uses for externalBin.
    println!(
        "cargo:rustc-env=PAPERFORGE_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("cargo sets TARGET")
    );
    tauri_build::build()
}
