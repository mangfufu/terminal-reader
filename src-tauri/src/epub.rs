//! Read EPUB publications as local, inert text. Archive members are never extracted
//! to disk, scripts/resources are never executed, and all decompression is bounded.
use roxmltree::{Document, Node, ParsingOptions};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
};
use zip::ZipArchive;

pub const MAX_EPUB_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_EXPANDED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
const MAX_BLOCKS: usize = 200_000;

#[derive(Debug, Serialize)]
pub struct Block {
    pub text: String,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Chapter {
    pub title: String,
    pub block: usize,
    pub level: usize,
}

#[derive(Debug)]
pub struct Publication {
    pub title: Option<String>,
    pub author: Option<String>,
    pub content: String,
    pub blocks: Vec<Block>,
    pub chapters: Vec<Chapter>,
    pub warnings: Vec<String>,
}

struct ManifestItem {
    path: String,
    media_type: String,
    properties: String,
}
struct TocEntry {
    title: String,
    target: String,
    level: usize,
}

fn xml(text: &str) -> Result<Document<'_>, String> {
    Document::parse_with_options(
        text,
        ParsingOptions {
            // EPUB 2 commonly declares an XHTML DTD. No external resolver is installed;
            // external files and the network cannot be consulted. roxmltree bounds entities.
            allow_dtd: true,
            nodes_limit: 500_000,
            ..ParsingOptions::default()
        },
    )
    .map_err(|error| format!("EPUB XML 无法解析：{error}"))
}

fn text_of(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter_map(|n| n.is_text().then(|| n.text()).flatten())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn percent_decode(input: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(input.len());
    let source = input.as_bytes();
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            let pair = source
                .get(index + 1..index + 3)
                .ok_or("EPUB 链接转义不完整")?;
            let hex = std::str::from_utf8(pair).map_err(|_| "EPUB 链接转义无效")?;
            bytes.push(u8::from_str_radix(hex, 16).map_err(|_| "EPUB 链接转义无效")?);
            index += 3;
        } else {
            bytes.push(source[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| "EPUB 链接不是 UTF-8".into())
}

/// Resolve publication URLs without ever mapping them to the host filesystem.
fn resolve(base_file: &str, href: &str) -> Result<String, String> {
    let (raw_path, fragment) = href.split_once('#').unwrap_or((href, ""));
    let path = percent_decode(raw_path.split('?').next().unwrap_or_default())?;
    if path.contains(['\\', ':', '\0']) || path.starts_with('/') {
        return Err("EPUB 包含外部或无效的资源路径".into());
    }
    let mut pieces: Vec<&str> = if path.is_empty() {
        base_file.split('/').collect()
    } else {
        base_file
            .rsplit_once('/')
            .map(|(dir, _)| dir.split('/').collect())
            .unwrap_or_default()
    };
    for part in path.split('/').filter(|p| !p.is_empty() && *p != ".") {
        if part == ".." {
            pieces.pop().ok_or("EPUB 资源路径越过书籍根目录")?;
        } else {
            pieces.push(part);
        }
    }
    let mut resolved = pieces.join("/");
    if resolved.is_empty() {
        return Err("EPUB 资源路径为空".into());
    }
    if !fragment.is_empty() {
        resolved.push('#');
        resolved.push_str(&percent_decode(fragment)?);
    }
    Ok(resolved)
}

fn read_text(archive: &mut ZipArchive<Cursor<&[u8]>>, path: &str) -> Result<String, String> {
    let member = archive
        .by_name(path)
        .map_err(|error| format!("EPUB 缺少或无法读取 {path}：{error}"))?;
    if member.encrypted() {
        return Err("不支持受密码保护的 EPUB".into());
    }
    if member.size() > MAX_XML_BYTES {
        return Err(format!("EPUB 文本条目 {path} 超过 16 MB"));
    }
    let mut bytes = Vec::new();
    member
        .take(MAX_XML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("EPUB 解压失败 {path}：{error}"))?;
    if bytes.len() as u64 > MAX_XML_BYTES {
        return Err(format!("EPUB 文本条目 {path} 超过 16 MB"));
    }
    let text = if let Some((encoding, bom)) = encoding_rs::Encoding::for_bom(&bytes) {
        let (text, errors) = encoding.decode_without_bom_handling(&bytes[bom..]);
        if errors {
            return Err(format!("EPUB 文本编码损坏：{path}"));
        }
        text.into_owned()
    } else {
        String::from_utf8(bytes).map_err(|_| format!("EPUB 文本须为 UTF-8/UTF-16：{path}"))?
    };
    Ok(normalize_entities(&text))
}

/// Resolve XHTML named entities locally, preserving XML's own escaping. Replacing
/// amp/lt/gt first would turn book text back into markup, so only HTML names change.
fn normalize_entities(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest.as_bytes().iter().take(40).position(|c| *c == b';');
        if let Some(end) = end {
            let name = &rest[1..end];
            if !matches!(name, "amp" | "lt" | "gt" | "quot" | "apos")
                && name.bytes().all(|c| c.is_ascii_alphanumeric())
            {
                let entity = &rest[..end + 1];
                let decoded = html_escape::decode_html_entities(entity);
                if decoded != entity {
                    for character in decoded.chars() {
                        output.push_str(&format!("&#{};", character as u32));
                    }
                    rest = &rest[end + 1..];
                    continue;
                }
            }
        }
        output.push('&');
        rest = &rest[1..];
    }
    output.push_str(rest);
    output
}

fn inspect_archive(archive: &mut ZipArchive<Cursor<&[u8]>>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("EPUB 包含超过 10000 个压缩条目".into());
    }
    let mut expanded = 0u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let member = archive
            .by_index_raw(index)
            .map_err(|error| format!("EPUB 压缩目录损坏：{error}"))?;
        if member.encrypted() {
            return Err("不支持受密码保护的 EPUB".into());
        }
        expanded = expanded
            .checked_add(member.size())
            .ok_or("EPUB 解压大小溢出")?;
        if expanded > MAX_EXPANDED_BYTES {
            return Err("EPUB 解压后超过 128 MB 限制".into());
        }
        let name = member.name();
        if name.contains(['\\', '\0'])
            || name.starts_with('/')
            || name.split('/').any(|p| p == ".." || p.contains(':'))
        {
            return Err("EPUB 包含无效的压缩条目路径".into());
        }
        if !names.insert(name.to_owned()) {
            return Err("EPUB 包含重复的压缩条目路径".into());
        }
    }
    Ok(())
}

fn preflight_directory(bytes: &[u8]) -> Result<(), String> {
    // Check counts before ZipArchive allocates a vector for the central directory.
    // ZIP comments have a 16-bit length; the EOCD must finish at the file's end.
    let start = bytes.len().saturating_sub(65_557);
    let eocd = bytes[start..]
        .windows(4)
        .enumerate()
        .rev()
        .find_map(|(relative, signature)| {
            let offset = start + relative;
            if signature != b"PK\x05\x06" || offset + 22 > bytes.len() {
                return None;
            }
            let comment = u16::from_le_bytes([bytes[offset + 20], bytes[offset + 21]]) as usize;
            (offset + 22 + comment == bytes.len()).then_some(offset)
        })
        .ok_or("EPUB 压缩包缺少有效的目录尾记录")?;
    let count = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]) as u64;
    if count > MAX_ARCHIVE_ENTRIES as u64 {
        return Err("EPUB 包含超过 10000 个压缩条目".into());
    }
    if eocd >= 20 && &bytes[eocd - 20..eocd - 16] == b"PK\x06\x07" {
        let locator = eocd - 20;
        let record = u64::from_le_bytes(bytes[locator + 8..locator + 16].try_into().unwrap());
        let record = usize::try_from(record).map_err(|_| "EPUB ZIP64 目录位置无效")?;
        if record.checked_add(56).is_none_or(|end| end > bytes.len())
            || &bytes[record..record + 4] != b"PK\x06\x06"
        {
            return Err("EPUB ZIP64 目录损坏".into());
        }
        let count = u64::from_le_bytes(bytes[record + 32..record + 40].try_into().unwrap());
        if count > MAX_ARCHIVE_ENTRIES as u64 {
            return Err("EPUB 包含超过 10000 个压缩条目".into());
        }
    }
    Ok(())
}

#[derive(Default)]
struct Extractor {
    blocks: Vec<Block>,
    anchors: HashMap<String, usize>,
    headings: Vec<Chapter>,
    buffer: String,
    kind: &'static str,
    bytes: usize,
}

impl Extractor {
    fn flush(&mut self) -> Result<(), String> {
        let raw = std::mem::take(&mut self.buffer);
        let text = if self.kind == "code" {
            raw.trim_matches(['\r', '\n']).to_owned()
        } else {
            raw.split_whitespace().collect::<Vec<_>>().join(" ")
        };
        if text.trim().is_empty() {
            return Ok(());
        }
        self.bytes += text.len() + 2;
        if self.bytes > MAX_TEXT_BYTES || self.blocks.len() >= MAX_BLOCKS {
            return Err("EPUB 正文超过 16 MB 或 200000 段限制".into());
        }
        self.blocks.push(Block {
            text,
            kind: if self.kind.is_empty() {
                "paragraph"
            } else {
                self.kind
            },
        });
        Ok(())
    }

    fn visit(
        &mut self,
        node: Node<'_, '_>,
        depth: usize,
        inherited: &'static str,
    ) -> Result<(), String> {
        if depth > 256 {
            return Err("EPUB 正文嵌套层级过深".into());
        }
        if node.is_text() {
            self.buffer.push_str(node.text().unwrap_or_default());
            return Ok(());
        }
        if !node.is_element() {
            return Ok(());
        }
        let tag = node.tag_name().name();
        if matches!(
            tag,
            "head" | "script" | "style" | "svg" | "noscript" | "iframe" | "object"
        ) || node.has_attribute("hidden")
            || node.attribute("aria-hidden") == Some("true")
        {
            return Ok(());
        }
        let heading_level = match tag {
            "h1" => 1,
            "h2" => 2,
            "h3" => 3,
            "h4" => 4,
            "h5" => 5,
            "h6" => 6,
            _ => 0,
        };
        let boundary = heading_level > 0
            || matches!(
                tag,
                "p" | "div"
                    | "section"
                    | "article"
                    | "body"
                    | "li"
                    | "ul"
                    | "ol"
                    | "blockquote"
                    | "pre"
                    | "table"
                    | "tr"
                    | "td"
                    | "th"
                    | "figcaption"
                    | "figure"
                    | "dl"
                    | "dt"
                    | "dd"
                    | "hr"
            );
        if boundary {
            self.flush()?;
        }
        let kind = if heading_level > 0 {
            "heading"
        } else if tag == "pre" {
            "code"
        } else if tag == "blockquote" {
            "quote"
        } else {
            inherited
        };
        if boundary {
            self.kind = kind;
        }
        let start = self.blocks.len();
        if let Some(id) = node
            .attribute("id")
            .or_else(|| node.attribute(("http://www.w3.org/XML/1998/namespace", "id")))
            .or_else(|| (tag == "a").then(|| node.attribute("name")).flatten())
        {
            self.anchors.entry(id.to_owned()).or_insert(start);
        }
        if tag == "br" {
            self.buffer.push('\n');
        }
        if tag == "img" {
            if let Some(alt) = node.attribute("alt").filter(|text| !text.trim().is_empty()) {
                self.buffer.push_str(&format!(" [图片：{alt}] "));
            }
        }
        for child in node.children() {
            self.visit(child, depth + 1, kind)?;
        }
        if boundary {
            self.flush()?;
            if heading_level > 0 && self.blocks.len() > start {
                self.headings.push(Chapter {
                    title: self.blocks[start].text.clone(),
                    block: start,
                    level: heading_level,
                });
            }
            self.kind = inherited;
        }
        Ok(())
    }
}

fn parse_nav(text: &str, path: &str) -> Result<Vec<TocEntry>, String> {
    let doc = xml(text)?;
    let nav = doc
        .descendants()
        .find(|node| {
            node.has_tag_name("nav")
                && (node.attributes().any(|a| {
                    a.name() == "type" && a.value().split_whitespace().any(|t| t == "toc")
                }) || node.attribute("role") == Some("doc-toc"))
        })
        .ok_or("EPUB 导航文档缺少 toc，已改用正文标题")?;
    nav.descendants()
        .filter(|node| node.has_tag_name("a"))
        .filter_map(|node| {
            let href = node.attribute("href")?;
            let title = text_of(node);
            if title.is_empty() {
                return None;
            }
            let level = node
                .ancestors()
                .take_while(|a| *a != nav)
                .filter(|a| a.has_tag_name("ol"))
                .count()
                .clamp(1, 6);
            Some(resolve(path, href).map(|target| TocEntry {
                title,
                target,
                level,
            }))
        })
        .collect()
}

fn parse_ncx(text: &str, path: &str) -> Result<Vec<TocEntry>, String> {
    let doc = xml(text)?;
    doc.descendants()
        .filter(|node| node.has_tag_name("navPoint"))
        .filter_map(|node| {
            let title = node
                .children()
                .find(|n| n.has_tag_name("navLabel"))
                .map(text_of)?;
            let src = node
                .children()
                .find(|n| n.has_tag_name("content"))?
                .attribute("src")?;
            let level = node
                .ancestors()
                .filter(|n| n.has_tag_name("navPoint"))
                .count()
                .clamp(1, 6);
            Some(resolve(path, src).map(|target| TocEntry {
                title,
                target,
                level,
            }))
        })
        .collect()
}

pub fn parse(bytes: &[u8]) -> Result<Publication, String> {
    if bytes.len() as u64 > MAX_EPUB_BYTES {
        return Err("EPUB 文件超过 64 MB 限制".into());
    }
    preflight_directory(bytes)?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("EPUB 压缩包损坏：{error}"))?;
    inspect_archive(&mut archive)?;
    if archive.index_for_name("META-INF/encryption.xml").is_some() {
        let encryption = read_text(&mut archive, "META-INF/encryption.xml")?;
        let doc = xml(&encryption)?;
        for encrypted in doc
            .descendants()
            .filter(|n| n.has_tag_name("EncryptedData"))
        {
            let algorithm = encrypted
                .descendants()
                .find(|n| n.has_tag_name("EncryptionMethod"))
                .and_then(|n| n.attribute("Algorithm"))
                .unwrap_or_default();
            // Standard embedded-font obfuscation does not protect readable book text.
            if !matches!(
                algorithm,
                "http://www.idpf.org/2008/embedding" | "http://ns.adobe.com/pdf/enc#RC"
            ) {
                return Err("此 EPUB 的内容受 DRM 加密保护，暂不支持导入".into());
            }
        }
    }
    let container = read_text(&mut archive, "META-INF/container.xml")?;
    let container_doc = xml(&container)?;
    let rootfile = container_doc
        .descendants()
        .filter(|n| n.has_tag_name("rootfile"))
        .find(|n| n.attribute("media-type") == Some("application/oebps-package+xml"))
        .or_else(|| {
            container_doc
                .descendants()
                .find(|n| n.has_tag_name("rootfile"))
        })
        .and_then(|n| n.attribute("full-path"))
        .ok_or("EPUB 缺少 package 根文档")?;
    let opf_path = resolve("", rootfile)?;
    let opf = read_text(&mut archive, &opf_path)?;
    let doc = xml(&opf)?;
    let metadata = doc.descendants().find(|n| n.has_tag_name("metadata"));
    let title = metadata
        .and_then(|m| m.descendants().find(|n| n.has_tag_name("title")))
        .map(text_of)
        .filter(|s| !s.is_empty());
    let authors = metadata
        .map(|m| {
            m.descendants()
                .filter(|n| n.has_tag_name("creator"))
                .map(text_of)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let author = (!authors.is_empty()).then(|| authors.join("、"));
    let mut manifest = HashMap::new();
    let manifest_node = doc
        .descendants()
        .find(|n| n.has_tag_name("manifest"))
        .ok_or("EPUB 缺少 manifest")?;
    for item in manifest_node.children().filter(|n| n.has_tag_name("item")) {
        let id = item.attribute("id").ok_or("EPUB manifest 条目缺少 id")?;
        let href = item
            .attribute("href")
            .ok_or("EPUB manifest 条目缺少 href")?;
        // Remote resources are allowed by EPUB but are not fetched by this reader.
        if href.contains("://") || href.starts_with("data:") {
            continue;
        }
        let entry = ManifestItem {
            path: resolve(&opf_path, href)?,
            media_type: item.attribute("media-type").unwrap_or_default().into(),
            properties: item.attribute("properties").unwrap_or_default().into(),
        };
        if manifest.insert(id.to_owned(), entry).is_some() {
            return Err("EPUB manifest 包含重复 id".into());
        }
    }
    let spine = doc
        .descendants()
        .find(|n| n.has_tag_name("spine"))
        .ok_or("EPUB 缺少 spine 阅读顺序")?;
    let mut blocks = Vec::new();
    let mut anchors = HashMap::new();
    let mut fallback = Vec::new();
    let mut text_bytes = 0usize;
    let mut spine_paths = HashSet::new();
    for reference in spine.children().filter(|n| n.has_tag_name("itemref")) {
        if reference.attribute("linear") == Some("no") {
            continue;
        }
        let idref = reference
            .attribute("idref")
            .ok_or("EPUB spine 条目缺少 idref")?;
        let item = manifest
            .get(idref)
            .ok_or_else(|| format!("EPUB spine 引用不存在或外部条目：{idref}"))?;
        if !matches!(
            item.media_type.as_str(),
            "application/xhtml+xml" | "text/html"
        ) {
            continue;
        }
        if !spine_paths.insert(item.path.clone()) {
            continue;
        }
        let chapter_text = read_text(&mut archive, &item.path)?;
        let chapter_doc = xml(&chapter_text).map_err(|error| format!("{}：{error}", item.path))?;
        let body = chapter_doc
            .descendants()
            .find(|n| n.has_tag_name("body"))
            .ok_or_else(|| format!("EPUB 章节缺少 body：{}", item.path))?;
        let mut extractor = Extractor::default();
        extractor.visit(body, 0, "paragraph")?;
        extractor.flush()?;
        text_bytes += extractor.bytes;
        if text_bytes > MAX_TEXT_BYTES || blocks.len() + extractor.blocks.len() > MAX_BLOCKS {
            return Err("EPUB 正文超过 16 MB 或 200000 段限制".into());
        }
        let offset = blocks.len();
        if extractor.blocks.is_empty() {
            continue;
        }
        anchors.insert(item.path.clone(), offset);
        for (id, block) in extractor.anchors {
            anchors.insert(
                format!("{}#{id}", item.path),
                offset + block.min(extractor.blocks.len() - 1),
            );
        }
        if extractor.headings.is_empty() {
            let chapter_title = chapter_doc
                .descendants()
                .find(|n| n.has_tag_name("title"))
                .map(text_of)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("章节 {}", fallback.len() + 1));
            fallback.push(Chapter {
                title: chapter_title,
                block: offset,
                level: 1,
            });
        } else {
            fallback.extend(extractor.headings.into_iter().map(|c| Chapter {
                block: c.block + offset,
                ..c
            }));
        }
        blocks.extend(extractor.blocks);
    }
    if blocks.is_empty() {
        return Err("此 EPUB 没有可读取的正文（扫描图片版暂不支持）".into());
    }
    let mut warnings = Vec::new();
    let nav = manifest
        .values()
        .find(|item| item.properties.split_whitespace().any(|p| p == "nav"));
    let ncx = spine
        .attribute("toc")
        .and_then(|id| manifest.get(id))
        .or_else(|| {
            manifest
                .values()
                .find(|item| item.media_type == "application/x-dtbncx+xml")
        });
    let mut toc = Vec::new();
    for (item, epub3) in nav
        .map(|item| (item, true))
        .into_iter()
        .chain(ncx.map(|item| (item, false)))
    {
        let parsed = read_text(&mut archive, &item.path).and_then(|text| {
            if epub3 {
                parse_nav(&text, &item.path)
            } else {
                parse_ncx(&text, &item.path)
            }
        });
        match parsed {
            Ok(entries) if !entries.is_empty() => {
                toc = entries;
                break;
            }
            Ok(_) => (),
            Err(error) => warnings.push(format!("目录读取失败，已尝试备用目录：{error}")),
        }
    }
    let mut chapters = Vec::new();
    let mut chapter_seen = HashSet::new();
    for entry in toc {
        let resolved = anchors.get(&entry.target).copied().or_else(|| {
            entry
                .target
                .split_once('#')
                .and_then(|(path, _)| anchors.get(path).copied())
        });
        if let Some(block) = resolved {
            if chapter_seen.insert((block, entry.title.clone())) {
                chapters.push(Chapter {
                    title: entry.title,
                    block,
                    level: entry.level,
                });
            }
        }
    }
    if chapters.is_empty() {
        chapters = fallback;
    }
    let content = blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(Publication {
        title,
        author,
        content,
        blocks,
        chapters,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn archive(entries: Vec<(&str, String)>) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, text) in entries {
            zip.start_file(
                path,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn fixture(epub3: bool, extras: Vec<(&str, String)>) -> Vec<u8> {
        let toc = if epub3 {
            r#"<item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>"#
        } else {
            r#"<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>"#
        };
        let mut entries = vec![
            ("mimetype", "application/epub+zip".into()),
            ("META-INF/container.xml", r#"<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#.into()),
            ("OPS/book.opf", format!(r#"<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>测试书</dc:title><dc:creator>测试作者</dc:creator></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="text/two%20chapter.xhtml" media-type="application/xhtml+xml"/>{toc}</manifest><spine toc="toc"><itemref idref="two"/><itemref idref="one"/></spine></package>"#)),
            ("OPS/one.xhtml", r#"<html><head><title>一</title><script>BAD HEAD</script></head><body><h1 id="one">第一章</h1><p>第一章正文</p></body></html>"#.into()),
            ("OPS/text/two chapter.xhtml", r#"<html><body><h1 id="two">第二章</h1><p>你好<strong>世界</strong>&nbsp;。</p><div id="part"><blockquote><p>引言</p></blockquote><pre>  let a = 1;
    next();</pre></div><script>BAD SCRIPT</script><p hidden="">BAD HIDDEN</p></body></html>"#.into()),
        ];
        if epub3 {
            entries.push(("OPS/nav.xhtml", r##"<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/two%20chapter.xhtml#two">第二章目录</a><ol><li><a href="text/two%20chapter.xhtml#part">第二章小节</a></li></ol></li><li><a href="one.xhtml#one">第一章目录</a></li></ol></nav></body></html>"##.into()));
        } else {
            entries.push(("OPS/toc.ncx", r##"<ncx><navMap><navPoint><navLabel><text>第二章目录</text></navLabel><content src="text/two%20chapter.xhtml#two"/><navPoint><navLabel><text>第二章小节</text></navLabel><content src="text/two%20chapter.xhtml#part"/></navPoint></navPoint><navPoint><navLabel><text>第一章目录</text></navLabel><content src="one.xhtml#one"/></navPoint></navMap></ncx>"##.into()));
        }
        entries.retain(|(path, _)| !extras.iter().any(|(replacement, _)| replacement == path));
        entries.extend(extras);
        archive(entries)
    }

    #[test]
    fn epub2_and_epub3_preserve_spine_metadata_toc_and_safe_text() {
        for epub3 in [false, true] {
            let book = parse(&fixture(epub3, vec![])).unwrap();
            assert_eq!(book.title.as_deref(), Some("测试书"));
            assert_eq!(book.author.as_deref(), Some("测试作者"));
            assert_eq!(book.blocks[0].text, "第二章");
            assert_eq!(book.blocks[1].text, "你好世界 。");
            assert_eq!(book.blocks[2].kind, "quote");
            assert_eq!(book.blocks[3].kind, "code");
            assert!(book.blocks[3].text.starts_with("  let"));
            assert!(!book.content.contains("BAD"));
            assert_eq!(book.chapters.len(), 3);
            assert_eq!(book.chapters[0].title, "第二章目录");
            assert_eq!(book.chapters[1].level, 2);
            assert_eq!(book.blocks[book.chapters[1].block].text, "引言");
            assert_eq!(book.blocks[book.chapters[2].block].text, "第一章");
        }
    }

    #[test]
    fn native_import_returns_epub_contract_and_canonical_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("一本书.EPUB");
        std::fs::write(&path, fixture(true, vec![])).unwrap();
        let result = crate::import_files(vec![path.to_string_lossy().to_string()], |_| {});
        assert!(result.warnings.is_empty());
        assert_eq!(result.files.len(), 1);
        let book = &result.files[0];
        assert_eq!(book.format, Some("epub"));
        assert_eq!(
            book.id,
            std::fs::canonicalize(path).unwrap().to_string_lossy()
        );
        assert_eq!(book.title.as_deref(), Some("测试书"));
        assert_eq!(book.chapters.as_ref().unwrap().len(), 3);
        assert_eq!(book.blocks.as_ref().unwrap()[0].text, "第二章");
    }

    #[test]
    fn rejects_drm_but_accepts_obfuscated_fonts() {
        let encryption = |algorithm: &str| {
            format!(
                r#"<encryption><EncryptedData><EncryptionMethod Algorithm="{algorithm}"/></EncryptedData></encryption>"#
            )
        };
        assert!(parse(&fixture(
            true,
            vec![(
                "META-INF/encryption.xml",
                encryption("http://www.w3.org/2001/04/xmlenc#aes128-cbc")
            )]
        ))
        .unwrap_err()
        .contains("DRM"));
        assert!(parse(&fixture(
            true,
            vec![(
                "META-INF/encryption.xml",
                encryption("http://www.idpf.org/2008/embedding")
            )]
        ))
        .is_ok());
    }

    #[test]
    fn rejects_missing_entries_and_unsafe_paths() {
        assert!(parse(b"not a zip").unwrap_err().contains("压缩包"));
        assert!(
            parse(&archive(vec![("mimetype", "application/epub+zip".into())]))
                .unwrap_err()
                .contains("container.xml")
        );
        assert!(
            parse(&fixture(true, vec![("../escape.xhtml", "bad".into())]))
                .unwrap_err()
                .contains("路径")
        );
        assert!(resolve("OPS/book.opf", "../../escape").is_err());
        assert!(resolve("OPS/book.opf", "https://example.com/book").is_err());
        assert_eq!(
            resolve("OPS/book.opf", "text/a%20b.xhtml#part%201").unwrap(),
            "OPS/text/a b.xhtml#part 1"
        );
        assert_eq!(
            resolve("OPS/text/a.xhtml", "#start").unwrap(),
            "OPS/text/a.xhtml#start"
        );
        let missing_spine = r#"<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="missing"/></spine></package>"#;
        assert!(
            parse(&fixture(true, vec![("OPS/book.opf", missing_spine.into())]))
                .unwrap_err()
                .contains("spine 引用不存在")
        );
        let missing_file = missing_spine
            .replace("idref=\"missing\"", "idref=\"one\"")
            .replace("href=\"one.xhtml\"", "href=\"absent.xhtml\"");
        assert!(parse(&fixture(true, vec![("OPS/book.opf", missing_file)]))
            .unwrap_err()
            .contains("absent.xhtml"));
    }

    #[test]
    fn falls_back_to_headings_and_supports_epub2_entities_without_external_fetches() {
        let book = parse(&fixture(true, vec![
            ("OPS/nav.xhtml", "<html><body><p>Broken navigation</p></body></html>".into()),
            ("OPS/one.xhtml", r#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "https://example.invalid/xhtml11.dtd"><html><body><h1>第一章</h1><p>Caf&eacute; &amp; &lt;safe&gt;</p></body></html>"#.into()),
        ])).unwrap();
        assert_eq!(book.chapters.len(), 2);
        assert!(!book.warnings.is_empty());
        assert!(book.content.contains("Café & <safe>"));
        assert!(xml(r#"<!DOCTYPE html [<!ENTITY external SYSTEM "file:///does-not-exist">]><html>&external;</html>"#).is_err());
    }

    #[test]
    fn rejects_zip_encryption_and_declared_expansion_limit() {
        let mut encrypted = fixture(true, vec![]);
        let local = encrypted
            .windows(4)
            .position(|bytes| bytes == b"PK\x03\x04")
            .unwrap();
        let central = encrypted
            .windows(4)
            .position(|bytes| bytes == b"PK\x01\x02")
            .unwrap();
        encrypted[local + 6] |= 1;
        encrypted[central + 8] |= 1;
        assert!(parse(&encrypted).unwrap_err().contains("密码"));
        let mut expanded = fixture(true, vec![]);
        let central = expanded
            .windows(4)
            .position(|bytes| bytes == b"PK\x01\x02")
            .unwrap();
        expanded[central + 24..central + 28]
            .copy_from_slice(&((MAX_EXPANDED_BYTES + 1) as u32).to_le_bytes());
        assert!(parse(&expanded).unwrap_err().contains("128 MB"));
    }

    #[test]
    fn enforces_archive_and_text_limits_before_large_allocation() {
        let oversized = "x".repeat(MAX_XML_BYTES as usize + 1);
        let bytes = archive(vec![("META-INF/container.xml", oversized)]);
        assert!(parse(&bytes).unwrap_err().contains("16 MB"));
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for index in 0..MAX_ARCHIVE_ENTRIES + 1 {
            zip.start_file(format!("entry-{index}"), SimpleFileOptions::default())
                .unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        assert!(parse(&bytes).unwrap_err().contains("10000"));
    }
}
