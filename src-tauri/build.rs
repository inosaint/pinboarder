fn main() {
    render_tray_icon();
    tauri_build::build();
}

fn render_tray_icon() {
    use resvg::{tiny_skia, usvg};

    let svg_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../public/pinboarder-tray.svg");
    let svg_data = std::fs::read_to_string(svg_path).expect("pinboarder-tray.svg not found");

    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_str(&svg_data, &opt).expect("failed to parse SVG");

    // 32×32 — macOS menu bar icon baseline size
    let size = 32u32;
    let scale = size as f32 / tree.size().width();
    let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("failed to create pixmap");
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());

    // Save as raw RGBA so we can use Image::new_owned at runtime (no PNG decoder needed)
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let mut raw = Vec::with_capacity(8 + pixmap.data().len());
    raw.extend_from_slice(&size.to_le_bytes()); // width
    raw.extend_from_slice(&size.to_le_bytes()); // height
    raw.extend_from_slice(pixmap.data());        // RGBA pixels
    std::fs::write(format!("{}/tray-icon.raw", out_dir), raw).expect("failed to write tray icon");

    println!("cargo:rerun-if-changed=../public/pinboarder-tray.svg");
}
