from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader
from torchvision import datasets, models, transforms


def build_loaders(dataset_dir: Path, batch_size: int) -> tuple[DataLoader, DataLoader, list[str]]:
    train_tf = transforms.Compose(
        [
            transforms.Resize((224, 224)),
            transforms.RandomHorizontalFlip(),
            transforms.RandomRotation(8),
            transforms.ColorJitter(brightness=0.15, contrast=0.15, saturation=0.10),
            transforms.ToTensor(),
            transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
        ]
    )
    val_tf = transforms.Compose(
        [
            transforms.Resize((224, 224)),
            transforms.ToTensor(),
            transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
        ]
    )
    train_set = datasets.ImageFolder(dataset_dir / "train", transform=train_tf)
    val_set = datasets.ImageFolder(dataset_dir / "val", transform=val_tf)
    if train_set.classes != val_set.classes:
        raise ValueError("Train/val classes differ.")
    return (
        DataLoader(train_set, batch_size=batch_size, shuffle=True, num_workers=0),
        DataLoader(val_set, batch_size=batch_size, shuffle=False, num_workers=0),
        list(train_set.classes),
    )


def accuracy(model: nn.Module, loader: DataLoader, device: torch.device) -> float:
    correct = 0
    total = 0
    model.eval()
    with torch.inference_mode():
        for images, labels in loader:
            images = images.to(device)
            labels = labels.to(device)
            predictions = model(images).argmax(dim=1)
            correct += int((predictions == labels).sum().item())
            total += int(labels.numel())
    return correct / max(1, total)


def main() -> int:
    parser = argparse.ArgumentParser(description="Train ARES university demo image classifier")
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, default=Path("uni-demo-vision.pt"))
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=24)
    parser.add_argument("--lr", type=float, default=2e-4)
    args = parser.parse_args()

    train_loader, val_loader, classes = build_loaders(args.dataset, args.batch_size)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    weights = models.MobileNet_V3_Small_Weights.DEFAULT
    model = models.mobilenet_v3_small(weights=weights)
    for parameter in model.features.parameters():
        parameter.requires_grad = False
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(classes))
    model = model.to(device)

    optimizer = torch.optim.AdamW(model.classifier.parameters(), lr=args.lr)
    criterion = nn.CrossEntropyLoss()

    best_accuracy = -1.0
    best_state = None
    for epoch in range(max(1, args.epochs)):
        model.train()
        for images, labels in train_loader:
            images = images.to(device)
            labels = labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(images), labels)
            loss.backward()
            optimizer.step()

        score = accuracy(model, val_loader, device)
        print(f"epoch={epoch + 1} val_accuracy={score:.4f}")
        if score > best_accuracy:
            best_accuracy = score
            best_state = {key: value.detach().cpu() for key, value in model.state_dict().items()}

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "architecture": "mobilenet_v3_small",
            "classes": classes,
            "state_dict": best_state,
            "validation_accuracy": best_accuracy,
        },
        args.output,
    )
    print(f"saved={args.output} classes={classes} best_val_accuracy={best_accuracy:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
