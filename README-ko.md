<p align="center">
  <a href="."><img height="160" src="./macos/AppIcon.iconset/icon_512x512.png" alt="Team Work"></a>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-Click-yellow" alt="English"></a>
  <a href="README-tw.md"><img src="https://img.shields.io/badge/繁體中文-點擊查看-orange" alt="繁體中文"></a>
  <a href="README-cn.md"><img src="https://img.shields.io/badge/简体中文-点击查看-orange" alt="简体中文"></a>
  <a href="README-ja.md"><img src="https://img.shields.io/badge/日本語-クリック-blue" alt="日本語"></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/한국어-클릭-yellow" alt="한국어"></a>
</p>

# Team Work

Team Work는 AI 에이전트 팀이 내 프로젝트에서 일하게 해 주는 macOS 앱입니다. 각 프로젝트는 픽셀 아트 섬 위의 건물 하나, 즉 회사가 됩니다. 직원은 AI 에이전트로, 워크플로를 따라 한 단계씩 작업합니다. 각 작업은 자기만의 Git 브랜치에서 진행되고, 결과는 사용자가 검토한 뒤 병합합니다.

![회사를 연 화면: 왼쪽은 사무실, 오른쪽은 작업 보드](./frontend/src/help/en/company.jpg)

## 기능

- **회사**: 프로젝트 폴더 하나와 대상 브랜치 하나가 회사 하나입니다. 완료한 작업과 직원이 늘수록 건물이 커집니다.
- **직원**: 블루프린트(프롬프트, 스킬, 허용 도구)로 만듭니다. 모델과 사고 수준은 직원마다 고를 수 있습니다. Backend Engineer, Code Reviewer, Technical Writer 등 16가지 블루프린트가 기본으로 들어 있습니다.
- **워크플로**: 작업이 거치는 단계로, Clarify requirements에서 시작해 Acceptance review로 끝납니다. 중간 단계는 직원에게 작업을 맡기거나 사용자와 논의하게 할 수 있습니다. Feature development, Bug fix, Refactor 등 6가지가 기본으로 들어 있습니다.
- **작업**: 작업마다 자기만의 Git worktree와 `task/<번호>` 브랜치에서 진행됩니다. 직원에게 질문이 생기면 작업은 사용자의 답변을 기다립니다. 검토를 통과하면 대상 브랜치에 병합하거나 다시 돌려보냅니다.
- **채팅**: 프로젝트 폴더에서 직원과 대화합니다. `$`로 스킬을 고르고 `@`로 파일을 언급합니다.
- **모델 제공자**: Anthropic, OpenAI, Google Gemini, 그리고 OpenAI 호환 API를 지원합니다. Claude 또는 ChatGPT 구독으로 로그인할 수도 있습니다.
- **스킬**: 블루프린트는 로컬 폴더나 GitHub 저장소에서 스킬을 불러옵니다.
- **터미널**: 회사마다 프로젝트 폴더에서 열리는 zsh 터미널이 있습니다.
- **언어**: 번체 중국어와 영어.

## 설치

1. [Releases](https://github.com/yanun0323/Team-Work/releases)에서 `Team-Work-macOS.zip`을 내려받습니다.
2. 압축을 풀고 `Team Work.app`을 응용 프로그램 폴더로 옮깁니다.

macOS 12 이상이 필요하며 Apple Silicon과 Intel을 지원합니다. 작업에는 Git이 필요하고, 프로젝트 폴더는 Git 저장소여야 합니다.

## 시작하기

1. Airport → Model providers에서 제공자를 하나 이상 추가해 직원이 사용할 모델을 준비합니다.
2. ＋ New company를 누르고 지도에서 위치를 고른 뒤, 프로젝트 폴더, 이름, 대상 브랜치를 입력합니다.
3. 회사의 Employees 탭에서 직원을 추가합니다. 블루프린트와 모델을 고릅니다.
4. Tasks 탭에서 작업을 만듭니다. 할 일을 적고, 워크플로를 고르고, 단계마다 담당 직원을 고릅니다.
5. 작업을 열어 Progress를 확인합니다. 빨간 느낌표가 붙은 단계는 사용자의 답변을 기다리고 있습니다.

오른쪽 위의 물음표를 누르면 자세한 안내가 열립니다.

앱의 표시 언어는 번체 중국어와 영어뿐이며, 위의 항목 이름은 영어 화면 기준입니다.

## 데이터와 보안

- 데이터는 `~/.team-work`에 저장됩니다. 다른 폴더를 쓰려면 `TEAM_WORK_HOME`에 절대 경로를 지정합니다.
- API 키와 로그인 정보는 `data.db`에 파일 권한 `0600`으로 저장되며, 암호화되지 않습니다.
- 명령 실행에는 샌드박스가 없습니다. 명령 실행 도구는 신뢰하는 블루프린트에서만 허용하세요.

## 소스에서 빌드

Go(버전은 `backend/go.mod` 참고), Node.js와 npm, Xcode 명령줄 도구가 필요합니다.

```sh
make dev           # 백엔드와 프런트엔드를 함께 실행 (http://localhost:5173)
make dev-mock      # 프런트엔드만, 모의 데이터로 실행
make test-backend  # 백엔드 테스트
make build         # dist/Team Work.app 빌드 (서명 안 됨)
```

`make help`로 모든 명령을 볼 수 있습니다. [백엔드](backend/README.md)와 [프런트엔드](frontend/README.md) 설명은 번체 중국어로 되어 있습니다.

## 라이선스

[Apache License 2.0](LICENSE)
