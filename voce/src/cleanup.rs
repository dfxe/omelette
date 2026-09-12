use crate::config::VocabularyEntry;
use regex::{Captures, Regex};
use std::sync::LazyLock;

static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
static BEFORE_PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+([,.;:!?])").unwrap());
static FILLERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(^|[\s,])(um+|uh+|erm+|ăă+|îî+)([\s,.!?]|$)").unwrap());

pub fn clean(
    raw: &str,
    language: &str,
    remove_fillers: bool,
    vocabulary: &[VocabularyEntry],
) -> String {
    let mut text = raw.trim().replace("\r\n", "\n");
    text = apply_commands(&text, language);
    if remove_fillers {
        text = FILLERS.replace_all(&text, "$1$3").into_owned();
    }
    for entry in vocabulary
        .iter()
        .filter(|entry| !entry.spoken.trim().is_empty())
    {
        let pattern =
            Regex::new(&format!(r"(?i)\b{}\b", regex::escape(entry.spoken.trim()))).unwrap();
        text = pattern
            .replace_all(&text, |_: &Captures<'_>| entry.written.as_str())
            .into_owned();
    }
    text = text
        .lines()
        .map(|line| SPACES.replace_all(line.trim(), " "))
        .collect::<Vec<_>>()
        .join("\n");
    text = BEFORE_PUNCT.replace_all(&text, "$1").into_owned();
    capitalize_first(text.trim())
}

fn apply_commands(text: &str, language: &str) -> String {
    let mut commands = vec![
        (r"(?i)\bnew paragraph\b", "\n\n"),
        (r"(?i)\bnew line\b", "\n"),
        (r"(?i)\bcomma\b", ","),
        (r"(?i)\bperiod\b|\bfull stop\b", "."),
        (r"(?i)\bquestion mark\b", "?"),
        (r"(?i)\bexclamation mark\b", "!"),
        (r"(?i)\bcolon\b", ":"),
        (r"(?i)\bsemicolon\b", ";"),
    ];
    if language == "ro" || language == "auto" {
        commands.extend([
            (r"(?i)\bparagraf nou\b", "\n\n"),
            (r"(?i)\brând nou\b", "\n"),
            (r"(?i)\bvirgulă\b", ","),
            (r"(?i)\bpunct\b", "."),
            (r"(?i)\bsemnul întrebării\b", "?"),
            (r"(?i)\bsemnul exclamării\b", "!"),
            (r"(?i)\bdouă puncte\b", ":"),
            (r"(?i)\bpunct și virgulă\b", ";"),
        ]);
    }
    commands
        .into_iter()
        .fold(text.to_owned(), |value, (pattern, replacement)| {
            Regex::new(pattern)
                .unwrap()
                .replace_all(&value, replacement)
                .into_owned()
        })
}

fn capitalize_first(value: &str) -> String {
    let Some((offset, first)) = value.char_indices().find(|(_, c)| c.is_alphabetic()) else {
        return value.to_owned();
    };
    let mut result = String::with_capacity(value.len());
    result.push_str(&value[..offset]);
    result.extend(first.to_uppercase());
    result.push_str(&value[offset + first.len_utf8()..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_english_commands_and_fillers() {
        assert_eq!(
            clean("um hello comma new line world period", "en", true, &[]),
            "Hello,\nworld."
        );
    }

    #[test]
    fn replaces_custom_vocabulary_without_changing_case_rule() {
        let vocabulary = vec![VocabularyEntry {
            spoken: "voice".into(),
            written: "Voce".into(),
        }];
        assert_eq!(clean("voice works", "en", false, &vocabulary), "Voce works");
    }

    #[test]
    fn supports_romanian_commands() {
        assert_eq!(
            clean("salut virgulă lume punct", "ro", false, &[]),
            "Salut, lume."
        );
    }
}
