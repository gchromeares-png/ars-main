from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader
from torchvision import datasets, models, transforms


NORMALIZE = transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))


def loader(path: Path, train: bool, batch_size: int) -> DataLoader:
    steps = [transforms.Resize((224, 224))]
    if train:
        steps += [transforms.RandomHorizontalFlip(), transforms.RandomRotation(8), transforms.ColorJitter(0.15, 0.15, 0.10)]
    steps += [transforms.ToTensor(), NORMALIZE]
    return DataLoader(datasets.ImageFolder(path, transform=transforms.Compose(steps)), batch_size=batch_size, shuffle=train, num_workers=0)


def accuracy(model: nn.Module, data: DataLoader, device: torch.device) -> float:
    model.eval(); correct = total = 0
    with torch.inference_mode():
        for images, labels in data:
            labels = labels.to(device)
            predictions = model(images.to(device)).argmax(dim=1)
            correct += int((predictions == labels).sum()); total += int(labels.numel())
    return correct / max(1, total)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, default=Path("vision-grid.pt"))
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=24)
    parser.add_argument("--lr", type=float, default=2e-4)
    args = parser.parse_args()

    train_data = loader(args.dataset / "train", True, args.batch_size)
    val_data = loader(args.dataset / "val", False, args.batch_size)
    classes = list(train_data.dataset.classes)
    if classes != list(val_data.dataset.classes):
        raise ValueError("Train/val classes differ")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT)
    for parameter in model.features.parameters():
        parameter.requires_grad = False
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(classes))
    model = model.to(device)
    optimizer = torch.optim.AdamW(model.classifier.parameters(), lr=args.lr)
    criterion = nn.CrossEntropyLoss()
    best_score, best_state = -1.0, None

    for epoch in range(max(1, args.epochs)):
        model.train()
        for images, labels in train_data:
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(images.to(device)), labels.to(device))
            loss.backward(); optimizer.step()
        score = accuracy(model, val_data, device)
        print(f"epoch={epoch + 1} val_accuracy={score:.4f}")
        if score > best_score:
            best_score = score
            best_state = {key: value.detach().cpu() for key, value in model.state_dict().items()}

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"architecture": "mobilenet_v3_small", "classes": classes, "state_dict": best_state, "validation_accuracy": best_score}, args.output)
    print(f"saved={args.output} classes={classes} best_val_accuracy={best_score:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
