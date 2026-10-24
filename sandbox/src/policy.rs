use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub ro: Vec<PathBuf>,
    pub rw: Vec<PathBuf>,
    #[serde(rename = "minAbi")]
    pub min_abi: u32,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub groups: Option<Vec<u32>>,
    #[serde(rename = "ensureDirs", default)]
    pub ensure_dirs: Vec<PathBuf>,
}

impl Policy {
    pub fn validate(self) -> Result<Self, String> {
        if self.uid == Some(0) {
            return Err("uid 0 is forbidden".to_owned());
        }
        if self.gid == Some(0) {
            return Err("gid 0 is forbidden".to_owned());
        }
        for path in self.ro.iter().chain(&self.rw).chain(&self.ensure_dirs) {
            if !path.is_absolute() {
                return Err(format!("path must be absolute: {}", path.display()));
            }
        }
        for path in &self.ensure_dirs {
            if !self.rw.contains(path) {
                return Err(format!(
                    "ensureDirs path must also appear in rw: {}",
                    path.display()
                ));
            }
        }
        for path in &self.ro {
            if self.rw.contains(path) {
                return Err(format!(
                    "path appears in both ro and rw: {}",
                    path.display()
                ));
            }
        }
        Ok(self)
    }
}
