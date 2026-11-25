//! Signed multipart update manifests. All bytes are authenticated before installation.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

const MAX_PART_BYTES: usize = 90 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 1024 * 1024 * 1024;
const CHANNEL: &str = "https://gitee.com/xiang834740239/huanggua-aiagent/releases/download";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    schema_version: u32,
    version: String,
    target: String,
    pub total_bytes: usize,
    sha256: String,
    pub parts: Vec<Part>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Part {
    pub url: String,
    pub signature: String,
    bytes: usize,
    sha256: String,
}

pub fn archive_name(version: &str, target: &str) -> Result<String, String> {
    let version_parts: Vec<_> = version.split('.').collect();
    if version.len() > 48
        || version_parts.len() != 3
        || version_parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err("更新版本无效".into());
    }
    let arch = match target {
        "darwin-aarch64" => "arm64",
        "darwin-x86_64" => "x64",
        _ => return Err("更新平台不匹配".into()),
    };
    Ok(format!("HuangGuaAI-{version}-macos-{arch}.app.tar.gz"))
}

pub fn descriptor_url(version: &str, target: &str) -> Result<Url, String> {
    let name = archive_name(version, target)?;
    Url::parse(&format!("{CHANNEL}/v{version}/{name}.update.json"))
        .map_err(|_| "更新地址无效".into())
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn matches(bytes: &[u8], size: usize, expected_hash: &str) -> bool {
    bytes.len() == size && format!("{:x}", Sha256::digest(bytes)) == expected_hash
}

impl Manifest {
    /// Called only with bytes already verified by the native updater's pinned key.
    pub fn parse(bytes: &[u8], version: &str, target: &str) -> Result<Self, String> {
        if bytes.len() > 1024 * 1024 {
            return Err("更新分片清单过大".into());
        }
        let manifest: Self = serde_json::from_slice(bytes).map_err(|_| "更新分片清单无效")?;
        let name = archive_name(version, target)?;
        if manifest.schema_version != 1
            || manifest.version != version
            || manifest.target != target
            || manifest.parts.is_empty()
            || manifest.parts.len() > 16
            || manifest.total_bytes == 0
            || manifest.total_bytes > MAX_ARCHIVE_BYTES
            || !valid_hash(&manifest.sha256)
        {
            return Err("更新分片清单与版本或平台不匹配".into());
        }
        let mut total = 0usize;
        for (index, part) in manifest.parts.iter().enumerate() {
            let expected = format!("{CHANNEL}/v{version}/{name}.part{:03}", index + 1);
            if part.url != expected
                || part.bytes == 0
                || part.bytes > MAX_PART_BYTES
                || !valid_hash(&part.sha256)
                || part.signature.is_empty()
                || part.signature.len() > 4096
            {
                return Err("更新分片地址、大小或签名无效".into());
            }
            total = total.checked_add(part.bytes).ok_or("更新包大小溢出")?;
        }
        if total != manifest.total_bytes {
            return Err("更新分片总大小不匹配".into());
        }
        Ok(manifest)
    }

    pub fn append_part(
        &self,
        archive: &mut Vec<u8>,
        index: usize,
        bytes: &[u8],
    ) -> Result<(), String> {
        let part = self.parts.get(index).ok_or("更新分片序号无效")?;
        let offset: usize = self.parts[..index].iter().map(|part| part.bytes).sum();
        if archive.len() != offset || !matches(bytes, part.bytes, &part.sha256) {
            return Err("更新分片缺失、顺序错误或内容校验失败".into());
        }
        archive.extend_from_slice(bytes);
        Ok(())
    }

    pub fn verify_archive(&self, archive: &[u8]) -> Result<(), String> {
        if !matches(archive, self.total_bytes, &self.sha256) {
            return Err("完整更新包校验失败，未安装更新".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        let name = archive_name("0.11.11", "darwin-aarch64").unwrap();
        let chunks: [&[u8]; 2] = [b"first", b"second"];
        serde_json::json!({"schemaVersion":1,"version":"0.11.11","target":"darwin-aarch64",
            "totalBytes":11,"sha256":format!("{:x}",Sha256::digest(b"firstsecond")),
            "parts":chunks.iter().enumerate().map(|(i,bytes)| serde_json::json!({
                "url":format!("{CHANNEL}/v0.11.11/{name}.part{:03}",i+1),
                "signature":"verified separately by tauri updater", "bytes":bytes.len(),
                "sha256":format!("{:x}",Sha256::digest(bytes))})).collect::<Vec<_>>()})
    }
    fn parse(value: &serde_json::Value) -> Result<Manifest, String> {
        Manifest::parse(
            &serde_json::to_vec(value).unwrap(),
            "0.11.11",
            "darwin-aarch64",
        )
    }
    #[test]
    fn assembles_only_complete_authentic_ordered_parts() {
        let manifest = parse(&fixture()).unwrap();
        let mut archive = Vec::new();
        assert!(manifest.append_part(&mut archive, 1, b"second").is_err());
        assert!(manifest.append_part(&mut archive, 0, b"FIRST").is_err());
        assert!(archive.is_empty());
        manifest.append_part(&mut archive, 0, b"first").unwrap();
        assert!(manifest.verify_archive(&archive).is_err());
        assert!(manifest.append_part(&mut archive, 0, b"first").is_err());
        manifest.append_part(&mut archive, 1, b"second").unwrap();
        manifest.verify_archive(&archive).unwrap();
        archive[0] ^= 1;
        assert!(manifest.verify_archive(&archive).is_err());
    }
    #[test]
    fn rejects_wrong_version_platform_urls_and_resource_limits() {
        let base = fixture();
        for (field, value) in [
            ("schemaVersion", serde_json::json!(2)),
            ("version", serde_json::json!("0.11.12")),
            ("target", serde_json::json!("darwin-x86_64")),
            ("totalBytes", serde_json::json!(10)),
            ("totalBytes", serde_json::json!(MAX_ARCHIVE_BYTES + 1)),
            ("sha256", serde_json::json!("invalid")),
        ] {
            let mut changed = base.clone();
            changed[field] = value;
            assert!(parse(&changed).is_err());
        }
        let url = base["parts"][0]["url"].as_str().unwrap();
        for invalid in [
            url.replace("https:", "http:"),
            url.replace("gitee.com", "evil.example"),
            url.replace("xiang834740239", "other"),
            url.replace("v0.11.11", "v0.11.12"),
            format!("{url}?redirect=1"),
            url.replace("part001", "part002"),
        ] {
            let mut changed = base.clone();
            changed["parts"][0]["url"] = invalid.into();
            assert!(parse(&changed).is_err());
        }
        let mut changed = base.clone();
        changed["parts"][0]["bytes"] = serde_json::json!(MAX_PART_BYTES + 1);
        assert!(parse(&changed).is_err());
        let mut changed = base;
        changed["parts"].as_array_mut().unwrap().pop();
        assert!(parse(&changed).is_err());
    }
}
